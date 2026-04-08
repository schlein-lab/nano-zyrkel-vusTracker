//! vus-tracker WASM library.
//! Only the clinvar types/stats/parser and wasm modules are compiled here.
//! The native binary (main.rs) has its own module tree.

pub mod clinvar;

#[cfg(target_arch = "wasm32")]
pub mod wasm;
