use thiserror::Error;

/// Why a plan was refused. Every variant is a refusal: nothing is defaulted or passed through.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PlanError {
    #[error("the plan is not valid JSON: {0}")]
    Json(String),
    #[error("the plan asks for {0}, which no plan may ask for")]
    Forbidden(String),
    #[error("{field}: {why}")]
    Invalid { field: &'static str, why: String },
    #[error("unsupported plan schema version {0}")]
    Version(u32),
}

impl PlanError {
    pub(crate) fn invalid(field: &'static str, why: impl Into<String>) -> Self {
        Self::Invalid {
            field,
            why: why.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RuntimeError {
    #[error("this engine does not support that yet: {0}")]
    Unsupported(String),
    #[error("refused: {0}")]
    Refused(String),
    #[error("no such workload")]
    NotFound,
    #[error("a workload with that name already exists")]
    Conflict,
    #[error("{op} failed (exit {code:?}): {detail}")]
    Engine {
        op: &'static str,
        code: Option<i32>,
        detail: String,
    },
    #[error("{op} ran too long and was stopped")]
    TimedOut { op: &'static str },
    #[error("could not read the engine's answer to {op}: {detail}")]
    Parse { op: &'static str, detail: String },
    #[error("could not run the engine: {0}")]
    Spawn(String),
}
