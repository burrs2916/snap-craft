//! `CoreML` inference via Vision (`VNCoreMLModel`, `VNCoreMLRequest`, and
//! `VNCoreMLFeatureValueObservation`).

use core::{ffi::c_char, ptr};
use std::{
    ffi::{CStr, CString},
    path::{Path, PathBuf},
};

use crate::classify::Classification;
use crate::error::{from_swift, VisionError};
use crate::ffi;
use crate::request_base::ImageBasedRequest;

/// Mirrors `VNImageCropAndScaleOption`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CoreMLImageCropAndScaleOption {
    CenterCrop = 0,
    ScaleFit = 1,
    ScaleFill = 2,
    ScaleFitRotate90CCW = 0x101,
    ScaleFillRotate90CCW = 0x102,
}

/// A safe wrapper for `VNCoreMLModel`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreMLModel {
    model_path: PathBuf,
    input_image_feature_name: Option<String>,
}

impl CoreMLModel {
    #[must_use]
    pub fn new(model_path: impl AsRef<Path>) -> Self {
        Self {
            model_path: model_path.as_ref().to_path_buf(),
            input_image_feature_name: None,
        }
    }

    #[must_use]
    pub fn with_input_image_feature_name(
        mut self,
        input_image_feature_name: impl Into<String>,
    ) -> Self {
        self.input_image_feature_name = Some(input_image_feature_name.into());
        self
    }

    #[must_use]
    pub fn model_path(&self) -> &Path {
        &self.model_path
    }

    #[must_use]
    pub fn input_image_feature_name(&self) -> Option<&str> {
        self.input_image_feature_name.as_deref()
    }
}

/// A safe `MLFeatureValue` wrapper for `VNCoreMLFeatureValueObservation`.
#[derive(Debug, Clone, PartialEq)]
pub enum CoreMLFeatureValue {
    Int64(i64),
    Double(f64),
    String(String),
    MultiArray { shape: Vec<usize>, values: Vec<f64> },
    Unknown { type_name: String },
}

/// A dedicated `VNCoreMLFeatureValueObservation` wrapper.
#[derive(Debug, Clone, PartialEq)]
pub struct CoreMLFeatureValueObservation {
    pub feature_name: Option<String>,
    pub value: CoreMLFeatureValue,
}

/// A dedicated `VNCoreMLRequest` wrapper.
#[derive(Debug, Clone, PartialEq)]
pub struct CoreMLRequest {
    model: CoreMLModel,
    image_based: ImageBasedRequest,
    image_crop_and_scale_option: CoreMLImageCropAndScaleOption,
}

impl CoreMLRequest {
    #[must_use]
    pub fn new(model_path: impl AsRef<Path>) -> Self {
        Self {
            model: CoreMLModel::new(model_path),
            image_based: ImageBasedRequest::new(),
            image_crop_and_scale_option: CoreMLImageCropAndScaleOption::CenterCrop,
        }
    }

    #[must_use]
    pub fn with_model(mut self, model: CoreMLModel) -> Self {
        self.model = model;
        self
    }

    #[must_use]
    pub const fn with_image_based_request(mut self, image_based: ImageBasedRequest) -> Self {
        self.image_based = image_based;
        self
    }

    #[must_use]
    pub const fn with_image_crop_and_scale_option(
        mut self,
        image_crop_and_scale_option: CoreMLImageCropAndScaleOption,
    ) -> Self {
        self.image_crop_and_scale_option = image_crop_and_scale_option;
        self
    }

    #[must_use]
    pub const fn image_based_request(&self) -> &ImageBasedRequest {
        &self.image_based
    }

    #[must_use]
    pub const fn image_crop_and_scale_option(&self) -> CoreMLImageCropAndScaleOption {
        self.image_crop_and_scale_option
    }

    #[must_use]
    pub const fn model(&self) -> &CoreMLModel {
        &self.model
    }

    /// Run the request as a classifier and return `VNClassificationObservation`
    /// values.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError`] if the image/model cannot be loaded or Vision
    /// rejects the request.
    pub fn classify(
        &self,
        image_path: impl AsRef<Path>,
    ) -> Result<Vec<Classification>, VisionError> {
        let image_c = path_to_cstring(image_path.as_ref(), "image path")?;
        let model_c = path_to_cstring(self.model.model_path(), "model path")?;
        let input_feature_c = self
            .model
            .input_image_feature_name()
            .map(|name| {
                CString::new(name).map_err(|err| {
                    VisionError::InvalidArgument(format!(
                        "input image feature name NUL byte: {err}"
                    ))
                })
            })
            .transpose()?;
        let roi = self.image_based.region_of_interest();
        let mut out_array = ptr::null_mut();
        let mut out_count = 0;
        let mut err_msg: *mut c_char = ptr::null_mut();
        // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
        let status = unsafe {
            ffi::vn_coreml_request_classify_in_path(
                image_c.as_ptr(),
                model_c.as_ptr(),
                input_feature_c
                    .as_ref()
                    .map_or(ptr::null(), |name| name.as_ptr()),
                input_feature_c.is_some(),
                self.image_crop_and_scale_option as i32,
                roi.map_or(0.0, |rect| rect.x),
                roi.map_or(0.0, |rect| rect.y),
                roi.map_or(1.0, |rect| rect.width),
                roi.map_or(1.0, |rect| rect.height),
                roi.is_some(),
                self.image_based.prefer_background_processing(),
                self.image_based.uses_cpu_only(),
                self.image_based.revision().unwrap_or_default(),
                self.image_based.revision().is_some(),
                &mut out_array,
                &mut out_count,
                &mut err_msg,
            )
        };
        if status != ffi::status::OK {
            // SAFETY: the error pointer is either null or a bridge-allocated C string; `from_swift` frees it.
            return Err(unsafe { from_swift(status, err_msg) });
        }
        Ok(collect_classifications(out_array, out_count))
    }

    /// Run the request and return a dedicated
    /// `VNCoreMLFeatureValueObservation`.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError`] if the image/model cannot be loaded or Vision
    /// rejects the request.
    pub fn feature_value(
        &self,
        image_path: impl AsRef<Path>,
    ) -> Result<Option<CoreMLFeatureValueObservation>, VisionError> {
        let image_c = path_to_cstring(image_path.as_ref(), "image path")?;
        let model_c = path_to_cstring(self.model.model_path(), "model path")?;
        let input_feature_c = self
            .model
            .input_image_feature_name()
            .map(|name| {
                CString::new(name).map_err(|err| {
                    VisionError::InvalidArgument(format!(
                        "input image feature name NUL byte: {err}"
                    ))
                })
            })
            .transpose()?;
        let roi = self.image_based.region_of_interest();
        let mut raw = ffi::CoreMLFeatureValueRaw {
            feature_name: ptr::null_mut(),
            type_name: ptr::null_mut(),
            kind: 0,
            int64_value: 0,
            double_value: 0.0,
            string_value: ptr::null_mut(),
            multi_array_shape: ptr::null_mut(),
            multi_array_shape_count: 0,
            multi_array_values: ptr::null_mut(),
            multi_array_value_count: 0,
        };
        let mut has_value = false;
        let mut err_msg: *mut c_char = ptr::null_mut();
        // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
        let status = unsafe {
            ffi::vn_coreml_feature_value_in_path(
                image_c.as_ptr(),
                model_c.as_ptr(),
                input_feature_c
                    .as_ref()
                    .map_or(ptr::null(), |name| name.as_ptr()),
                input_feature_c.is_some(),
                self.image_crop_and_scale_option as i32,
                roi.map_or(0.0, |rect| rect.x),
                roi.map_or(0.0, |rect| rect.y),
                roi.map_or(1.0, |rect| rect.width),
                roi.map_or(1.0, |rect| rect.height),
                roi.is_some(),
                self.image_based.prefer_background_processing(),
                self.image_based.uses_cpu_only(),
                self.image_based.revision().unwrap_or_default(),
                self.image_based.revision().is_some(),
                &mut raw,
                &mut has_value,
                &mut err_msg,
            )
        };
        if status != ffi::status::OK {
            // SAFETY: the error pointer is either null or a bridge-allocated C string; `from_swift` frees it.
            return Err(unsafe { from_swift(status, err_msg) });
        }
        if !has_value {
            return Ok(None);
        }
        let observation = CoreMLFeatureValueObservation {
            feature_name: string_from_ptr(raw.feature_name),
            value: match raw.kind {
                1 => CoreMLFeatureValue::Int64(raw.int64_value),
                2 => CoreMLFeatureValue::Double(raw.double_value),
                3 => CoreMLFeatureValue::String(
                    string_from_ptr(raw.string_value).unwrap_or_default(),
                ),
                4 => {
                    let shape =
                        if raw.multi_array_shape.is_null() || raw.multi_array_shape_count == 0 {
                            Vec::new()
                        } else {
                            // SAFETY: the pointer is valid for the reported element count as guaranteed by the bridge.
                            unsafe {
                                std::slice::from_raw_parts(
                                    raw.multi_array_shape,
                                    raw.multi_array_shape_count,
                                )
                            }
                            .to_vec()
                        };
                    let values =
                        if raw.multi_array_values.is_null() || raw.multi_array_value_count == 0 {
                            Vec::new()
                        } else {
                            // SAFETY: the pointer is valid for the reported element count as guaranteed by the bridge.
                            unsafe {
                                std::slice::from_raw_parts(
                                    raw.multi_array_values,
                                    raw.multi_array_value_count,
                                )
                            }
                            .to_vec()
                        };
                    CoreMLFeatureValue::MultiArray { shape, values }
                }
                _ => CoreMLFeatureValue::Unknown {
                    type_name: string_from_ptr(raw.type_name)
                        .unwrap_or_else(|| "unknown".to_string()),
                },
            },
        };
        // SAFETY: `raw` was populated by the bridge and has not been freed yet; unique free site.
        unsafe { ffi::vn_coreml_feature_value_free(&mut raw) };
        Ok(Some(observation))
    }
}

/// Run a Core ML classifier model on the image at `path`.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn coreml_classify_in_path(
    image_path: impl AsRef<Path>,
    model_path: impl AsRef<Path>,
) -> Result<Vec<Classification>, VisionError> {
    CoreMLRequest::new(model_path).classify(image_path)
}

/// Run a Core ML model that returns a feature value on the image at `path`.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn coreml_feature_value_in_path(
    image_path: impl AsRef<Path>,
    model_path: impl AsRef<Path>,
) -> Result<Option<CoreMLFeatureValueObservation>, VisionError> {
    CoreMLRequest::new(model_path).feature_value(image_path)
}

fn collect_classifications(
    out_array: *mut core::ffi::c_void,
    out_count: usize,
) -> Vec<Classification> {
    if out_array.is_null() || out_count == 0 {
        return Vec::new();
    }
    let typed = out_array.cast::<ffi::ClassificationRaw>();
    let mut values = Vec::with_capacity(out_count);
    for index in 0..out_count {
        // SAFETY: the pointer is valid for the reported element count; the index is in bounds.
        let raw = unsafe { &*typed.add(index) };
        values.push(Classification {
            identifier: string_from_ptr(raw.identifier).unwrap_or_default(),
            confidence: raw.confidence,
        });
    }
    // SAFETY: the pointer/count pair was allocated by the bridge and is freed exactly once here.
    unsafe { ffi::vn_classifications_free(out_array, out_count) };
    values
}

fn path_to_cstring(path: &Path, label: &str) -> Result<CString, VisionError> {
    let path = path
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument(format!("non-UTF-8 {label}")))?;
    CString::new(path)
        .map_err(|err| VisionError::InvalidArgument(format!("{label} NUL byte: {err}")))
}

fn string_from_ptr(ptr: *mut c_char) -> Option<String> {
    (!ptr.is_null()).then(|| {
        // SAFETY: the C string pointer is non-null (checked above) and valid for the duration of this borrow.
        unsafe { CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned()
    })
}
