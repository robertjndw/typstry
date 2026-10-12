//! Random identifiers for spaces and share links. They live in
//! typstry-wire because clients mint the tokens a rotation switches to and
//! have to match the shape the server checks.

pub use typstry_wire::token::{TOKEN_LEN, generate, looks_valid};
