//! Every way the updater says no. The codes are the TypeScript `BoxArtifactRefusal` names the shell
//! verifier printed, so the daemon and the apps read them unchanged.

use core::fmt;

/// A refusal: nothing on the box changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub detail: Option<String>,
}

impl Refusal {
    #[must_use]
    pub const fn new(code: &'static str) -> Self {
        Self { code, detail: None }
    }

    #[must_use]
    pub fn with(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: Some(detail.into()),
        }
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.detail {
            Some(d) => write!(f, "refused: {} ({d})", self.code),
            None => write!(f, "refused: {}", self.code),
        }
    }
}

impl std::error::Error for Refusal {}
