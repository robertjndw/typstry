//! The link between a device and one project's leaf key.

use loro_protocol::{BytesReader, BytesWriter};

use super::{DeviceKey, GraphError, MAX_GRAPH_BYTES, PersonGraph, malformed, verify};
use crate::crypto::{KEY_LEN, PublicKey, SIGNATURE_LEN};

/// Signed by the device key, so a binding can never be replayed as an entry
/// or any other signature.
const LEAF_BINDING_CONTEXT: &[u8] = b"typstry:v1:leaf-binding";
const IDENTITY_VERSION: u8 = 1;

/// A device key's statement that it owns a leaf signature key. Leaf keys are
/// per project, so this is what ties a project's member to a person without
/// the leaf key appearing anywhere else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeafBinding {
    pub device: PublicKey,
    pub sig: [u8; SIGNATURE_LEN],
}

impl LeafBinding {
    pub fn new(device: &DeviceKey, leaf_pub: &PublicKey) -> Self {
        Self {
            device: device.public(),
            sig: device.sign(&message(leaf_pub)),
        }
    }

    /// Whether the device vouches for `leaf_pub`.
    pub fn verify(&self, leaf_pub: &PublicKey) -> bool {
        verify(&self.device, &message(leaf_pub), &self.sig).is_ok()
    }
}

fn message(leaf_pub: &PublicKey) -> Vec<u8> {
    [LEAF_BINDING_CONTEXT, leaf_pub].concat()
}

/// What a leaf carries to say who it is: the binding and the graph that
/// says whether the binding's device counts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeafIdentity {
    pub binding: LeafBinding,
    pub graph: PersonGraph,
}

impl LeafIdentity {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = BytesWriter::new();
        w.push_byte(IDENTITY_VERSION);
        w.push_bytes(&self.binding.device);
        w.push_bytes(&self.binding.sig);
        w.push_var_bytes(&self.graph.encode());
        w.finalize()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, GraphError> {
        let bad = |e: String| malformed("leaf identity", e);
        let mut r = BytesReader::new(bytes);
        match r.read_byte().map_err(bad)? {
            IDENTITY_VERSION => {}
            v => return Err(GraphError::NewerVersion(v)),
        }
        let device = r
            .read_bytes(KEY_LEN)
            .map_err(bad)?
            .try_into()
            .expect("read 32 bytes");
        let sig = r
            .read_bytes(SIGNATURE_LEN)
            .map_err(bad)?
            .try_into()
            .expect("read 64 bytes");
        let graph = r.read_var_bytes().map_err(bad)?;
        if graph.len() > MAX_GRAPH_BYTES {
            return Err(GraphError::TooLarge);
        }
        let graph = PersonGraph::decode(graph)?;
        match r.remaining() {
            0 => Ok(Self {
                binding: LeafBinding { device, sig },
                graph,
            }),
            n => Err(bad(format!("{n} trailing bytes"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> (DeviceKey, PublicKey, LeafIdentity) {
        let device = DeviceKey::generate();
        let leaf = [5; KEY_LEN];
        let id = LeafIdentity {
            binding: LeafBinding::new(&device, &leaf),
            graph: PersonGraph::genesis(&device),
        };
        (device, leaf, id)
    }

    #[test]
    fn binding_verifies_only_for_its_leaf() {
        let (device, leaf, id) = identity();
        assert!(id.binding.verify(&leaf));
        assert!(!id.binding.verify(&[6; KEY_LEN]));
        assert_eq!(id.binding.device, device.public());
        let mut forged = id.binding.clone();
        forged.device = DeviceKey::generate().public();
        assert!(!forged.verify(&leaf));
    }

    #[test]
    fn identity_roundtrips() {
        let (_, _, id) = identity();
        assert_eq!(LeafIdentity::decode(&id.encode()).unwrap(), id);
    }

    #[test]
    fn identity_rejects_bad_encodings() {
        let (_, _, id) = identity();
        let bytes = id.encode();
        for len in 0..bytes.len() {
            assert!(LeafIdentity::decode(&bytes[..len]).is_err(), "prefix {len}");
        }
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(LeafIdentity::decode(&trailing).is_err());
        let mut newer = bytes.clone();
        newer[0] = 2;
        assert_eq!(
            LeafIdentity::decode(&newer),
            Err(GraphError::NewerVersion(2))
        );
    }

    #[test]
    fn identity_caps_the_graph() {
        let (_, _, id) = identity();
        let mut w = BytesWriter::new();
        w.push_byte(IDENTITY_VERSION);
        w.push_bytes(&id.binding.device);
        w.push_bytes(&id.binding.sig);
        w.push_var_bytes(&vec![0; MAX_GRAPH_BYTES + 1]);
        assert_eq!(
            LeafIdentity::decode(&w.finalize()),
            Err(GraphError::TooLarge)
        );
    }
}
