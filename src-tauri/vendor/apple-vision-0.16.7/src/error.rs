//! Errors from the Vision bridge.

use core::fmt;

use crate::ffi;

/// Top-level error type returned by Vision APIs in this crate.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum VisionError {
    /// Image at the supplied path could not be loaded.
    ImageLoadFailed(String),
    /// `VNImageRequestHandler.perform` returned an error.
    RequestFailed(String),
    /// Caller supplied an invalid argument (NUL byte in path, etc.).
    InvalidArgument(String),
    /// Catch-all for unmapped statuses from the Swift bridge.
    Unknown { code: i32, message: String },
}

impl fmt::Display for VisionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ImageLoadFailed(m) => write!(f, "image load failed: {m}"),
            Self::RequestFailed(m) => write!(f, "Vision request failed: {m}"),
            Self::InvalidArgument(m) => write!(f, "invalid argument: {m}"),
            Self::Unknown { code, message } => write!(f, "vision error {code}: {message}"),
        }
    }
}

impl std::error::Error for VisionError {}

/// Convert a Swift bridge status/error pair into a Rust [`VisionError`].
///
/// # Safety
///
/// `error_str` must be either null or a valid null-terminated C string
/// allocated by the Swift bridge. When non-null, this function takes
/// ownership and frees it exactly once via `vn_string_free`.
pub(crate) unsafe fn from_swift(status: i32, error_str: *mut core::ffi::c_char) -> VisionError {
    let message = if error_str.is_null() {
        String::new()
    } else {
        let s = core::ffi::CStr::from_ptr(error_str)
            .to_string_lossy()
            .into_owned();
        ffi::vn_string_free(error_str);
        s
    };
    match status {
        ffi::status::IMAGE_LOAD_FAILED => VisionError::ImageLoadFailed(message),
        ffi::status::REQUEST_FAILED => VisionError::RequestFailed(message),
        ffi::status::INVALID_ARGUMENT => VisionError::InvalidArgument(message),
        code => VisionError::Unknown { code, message },
    }
}
