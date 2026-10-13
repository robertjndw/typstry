//! The 256 words pairing codes and recovery keys are spelled with, one per
//! byte value.
//!
//! Short, common and unlike each other, so they are easy to read aloud and
//! type. The order is part of the format: a word's index is its byte, so
//! never reorder or edit the list.

pub const WORDS: [&str; 256] = [
    "acorn", "amber", "anchor", "angel", "anvil", "apple", "arrow", "atlas", "badge", "baker",
    "bamboo", "banjo", "basil", "beach", "beacon", "berry", "bison", "blade", "blanket", "bloom",
    "bonus", "boxer", "brave", "bread", "brick", "bridge", "brook", "brush", "bucket", "cabin",
    "cactus", "camel", "candle", "canoe", "canyon", "carbon", "carpet", "castle", "cedar",
    "cheese", "cherry", "chess", "chief", "cider", "circus", "citrus", "clever", "cliff", "clock",
    "cloud", "clover", "cobalt", "cobra", "comet", "cookie", "copper", "coral", "cotton", "cougar",
    "crane", "crayon", "crown", "crystal", "curtain", "daisy", "dance", "delta", "denim", "desert",
    "diamond", "dinner", "dolphin", "donkey", "dragon", "drift", "drum", "dune", "eagle", "earth",
    "ember", "engine", "fabric", "falcon", "feather", "fern", "fiddle", "field", "finch", "flame",
    "flint", "flute", "forest", "fossil", "fox", "galaxy", "garden", "garlic", "gecko", "ginger",
    "glacier", "glider", "globe", "goat", "golf", "grape", "gravel", "grove", "guitar", "hammer",
    "harbor", "harp", "hazel", "heron", "hill", "honey", "horizon", "hornet", "iceberg", "igloo",
    "indigo", "iron", "island", "ivory", "jacket", "jade", "jaguar", "jasmine", "jelly", "jewel",
    "jungle", "kayak", "kettle", "kitten", "kiwi", "koala", "ladder", "lagoon", "lantern", "lava",
    "lemon", "lily", "lizard", "lobster", "lotus", "lunar", "magnet", "mango", "maple", "marble",
    "maze", "meadow", "melon", "mint", "mirror", "monkey", "moon", "moss", "motor", "mountain",
    "mouse", "nectar", "needle", "nickel", "noodle", "north", "nova", "nutmeg", "oasis", "ocean",
    "olive", "onion", "opal", "orange", "orbit", "otter", "oyster", "paddle", "panda", "paper",
    "parrot", "peach", "pearl", "pebble", "pencil", "pepper", "piano", "pillow", "pilot", "pine",
    "pixel", "pizza", "planet", "plum", "pocket", "polar", "pony", "poppy", "puzzle", "quartz",
    "quill", "rabbit", "radar", "raven", "ridge", "river", "robot", "rocket", "ruby", "saddle",
    "sage", "salmon", "sand", "scarf", "shadow", "silver", "sketch", "slate", "smile", "snow",
    "spider", "spoon", "spring", "squid", "star", "storm", "sugar", "summer", "sunset", "swan",
    "table", "tiger", "timber", "toast", "tomato", "tower", "trail", "tulip", "tunnel", "turtle",
    "umbrella", "valley", "velvet", "vine", "violin", "walnut", "wander", "wheat", "willow",
    "window", "winter", "wolf", "yarn", "yellow", "zebra", "zephyr", "zinc",
];

/// The byte a word stands for, if it is one of [`WORDS`].
pub(crate) fn word_index(word: &str) -> Option<u8> {
    WORDS
        .iter()
        .position(|known| *known == word)
        .map(|i| i as u8)
}
