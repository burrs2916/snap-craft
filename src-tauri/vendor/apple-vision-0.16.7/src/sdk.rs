//! Vision SDK-wide enums, string constants, and version helpers.

use core::fmt;

macro_rules! vision_string_enum {
    (
        $(#[$meta:meta])*
        pub enum $name:ident {
            $( $variant:ident => $value:literal ),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name {
            $( $variant ),+
        }

        impl $name {
            /// Every currently-known SDK value for the enum family.
            pub const ALL: &'static [Self] = &[
                $( Self::$variant ),+
            ];

            /// Return the raw string value used by Vision.
            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self {
                    $( Self::$variant => $value ),+
                }
            }

            /// Parse a raw Vision string value.
            #[allow(clippy::should_implement_trait)]
            #[must_use]
            pub fn from_str(value: &str) -> Option<Self> {
                match value {
                    $( $value => Some(Self::$variant), )+
                    _ => None,
                }
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                self.as_str()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

vision_string_enum! {
    /// Mirrors `VNAnimalIdentifier`.
    pub enum AnimalIdentifier {
        Dog => "Dog",
        Cat => "Cat",
    }
}

vision_string_enum! {
    /// Mirrors `VNBarcodeSymbology`.
    pub enum BarcodeSymbology {
        Aztec => "VNBarcodeSymbologyAztec",
        Codabar => "VNBarcodeSymbologyCodabar",
        Code128 => "VNBarcodeSymbologyCode128",
        Code39 => "VNBarcodeSymbologyCode39",
        Code39Checksum => "VNBarcodeSymbologyCode39Checksum",
        Code39FullAscii => "VNBarcodeSymbologyCode39FullASCII",
        Code39FullAsciiChecksum => "VNBarcodeSymbologyCode39FullASCIIChecksum",
        Code93 => "VNBarcodeSymbologyCode93",
        Code93i => "VNBarcodeSymbologyCode93i",
        DataMatrix => "VNBarcodeSymbologyDataMatrix",
        Ean13 => "VNBarcodeSymbologyEAN13",
        Ean8 => "VNBarcodeSymbologyEAN8",
        Gs1DataBar => "VNBarcodeSymbologyGS1DataBar",
        Gs1DataBarExpanded => "VNBarcodeSymbologyGS1DataBarExpanded",
        Gs1DataBarLimited => "VNBarcodeSymbologyGS1DataBarLimited",
        I2of5 => "VNBarcodeSymbologyI2of5",
        I2of5Checksum => "VNBarcodeSymbologyI2of5Checksum",
        Itf14 => "VNBarcodeSymbologyITF14",
        MsiPlessey => "VNBarcodeSymbologyMSIPlessey",
        MicroPdf417 => "VNBarcodeSymbologyMicroPDF417",
        MicroQr => "VNBarcodeSymbologyMicroQR",
        Pdf417 => "VNBarcodeSymbologyPDF417",
        Qr => "VNBarcodeSymbologyQR",
        Upce => "VNBarcodeSymbologyUPCE",
    }
}

vision_string_enum! {
    /// Mirrors `VNComputeStage` and its exported string constants.
    pub enum ComputeStage {
        Main => "VNComputeStageMain",
        PostProcessing => "VNComputeStagePostProcessing",
    }
}

vision_string_enum! {
    /// Mirrors `VNImageOption`.
    pub enum ImageOption {
        Properties => "VNImageOptionProperties",
        CameraIntrinsics => "VNImageOptionCameraIntrinsics",
        CiContext => "VNImageOptionCIContext",
    }
}

vision_string_enum! {
    /// Mirrors `VNRecognizedPointGroupKeyAll`.
    pub enum RecognizedPointGroupKey {
        All => "VNIPOAll",
    }
}

vision_string_enum! {
    /// Mirrors `VNRecognizedPoint3DGroupKeyAll`.
    pub enum RecognizedPoint3DGroupKey {
        All => "VNIPOAll",
    }
}

/// Mirrors `VNImageCropAndScaleOption`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(usize)]
pub enum ImageCropAndScaleOption {
    CenterCrop = 0,
    ScaleFit = 1,
    ScaleFill = 2,
    ScaleFitRotate90Ccw = 0x101,
    ScaleFillRotate90Ccw = 0x102,
}

impl ImageCropAndScaleOption {
    /// Every currently-known SDK value.
    pub const ALL: &'static [Self] = &[
        Self::CenterCrop,
        Self::ScaleFit,
        Self::ScaleFill,
        Self::ScaleFitRotate90Ccw,
        Self::ScaleFillRotate90Ccw,
    ];

    #[must_use]
    pub const fn as_raw(self) -> usize {
        self as usize
    }

    #[must_use]
    pub const fn from_raw(raw: usize) -> Option<Self> {
        match raw {
            0 => Some(Self::CenterCrop),
            1 => Some(Self::ScaleFit),
            2 => Some(Self::ScaleFill),
            0x101 => Some(Self::ScaleFitRotate90Ccw),
            0x102 => Some(Self::ScaleFillRotate90Ccw),
            _ => None,
        }
    }
}

#[cfg(feature = "coreml")]
impl From<ImageCropAndScaleOption> for crate::coreml::CoreMLImageCropAndScaleOption {
    fn from(value: ImageCropAndScaleOption) -> Self {
        match value {
            ImageCropAndScaleOption::CenterCrop => Self::CenterCrop,
            ImageCropAndScaleOption::ScaleFit => Self::ScaleFit,
            ImageCropAndScaleOption::ScaleFill => Self::ScaleFill,
            ImageCropAndScaleOption::ScaleFitRotate90Ccw => Self::ScaleFitRotate90CCW,
            ImageCropAndScaleOption::ScaleFillRotate90Ccw => Self::ScaleFillRotate90CCW,
        }
    }
}

#[cfg(feature = "coreml")]
impl From<crate::coreml::CoreMLImageCropAndScaleOption> for ImageCropAndScaleOption {
    fn from(value: crate::coreml::CoreMLImageCropAndScaleOption) -> Self {
        match value {
            crate::coreml::CoreMLImageCropAndScaleOption::CenterCrop => Self::CenterCrop,
            crate::coreml::CoreMLImageCropAndScaleOption::ScaleFit => Self::ScaleFit,
            crate::coreml::CoreMLImageCropAndScaleOption::ScaleFill => Self::ScaleFill,
            crate::coreml::CoreMLImageCropAndScaleOption::ScaleFitRotate90CCW => {
                Self::ScaleFitRotate90Ccw
            }
            crate::coreml::CoreMLImageCropAndScaleOption::ScaleFillRotate90CCW => {
                Self::ScaleFillRotate90Ccw
            }
        }
    }
}

/// Mirrors `VNElementType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(usize)]
pub enum ElementType {
    Unknown = 0,
    Float32 = 1,
    Float64 = 2,
}

impl ElementType {
    pub const ALL: &'static [Self] = &[Self::Unknown, Self::Float32, Self::Float64];

    #[must_use]
    pub const fn as_raw(self) -> usize {
        self as usize
    }

    #[must_use]
    pub const fn from_raw(raw: usize) -> Option<Self> {
        match raw {
            0 => Some(Self::Unknown),
            1 => Some(Self::Float32),
            2 => Some(Self::Float64),
            _ => None,
        }
    }

    #[must_use]
    pub const fn size_in_bytes(self) -> usize {
        match self {
            Self::Unknown => 0,
            Self::Float32 => 4,
            Self::Float64 => 8,
        }
    }
}

/// Mirrors `VNPointsClassification`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(i32)]
pub enum PointsClassification {
    Disconnected = 0,
    OpenPath = 1,
    ClosedPath = 2,
}

impl PointsClassification {
    pub const ALL: &'static [Self] = &[Self::Disconnected, Self::OpenPath, Self::ClosedPath];

    #[must_use]
    pub const fn as_raw(self) -> i32 {
        self as i32
    }

    #[must_use]
    pub const fn from_raw(raw: i32) -> Option<Self> {
        match raw {
            0 => Some(Self::Disconnected),
            1 => Some(Self::OpenPath),
            2 => Some(Self::ClosedPath),
            _ => None,
        }
    }
}

/// Mirrors `VNBarcodeCompositeType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(i32)]
pub enum BarcodeCompositeType {
    None = 0,
    Linked = 1,
    Gs1TypeA = 2,
    Gs1TypeB = 3,
    Gs1TypeC = 4,
}

impl BarcodeCompositeType {
    pub const ALL: &'static [Self] = &[
        Self::None,
        Self::Linked,
        Self::Gs1TypeA,
        Self::Gs1TypeB,
        Self::Gs1TypeC,
    ];

    #[must_use]
    pub const fn as_raw(self) -> i32 {
        self as i32
    }

    #[must_use]
    pub const fn from_raw(raw: i32) -> Option<Self> {
        match raw {
            0 => Some(Self::None),
            1 => Some(Self::Linked),
            2 => Some(Self::Gs1TypeA),
            3 => Some(Self::Gs1TypeB),
            4 => Some(Self::Gs1TypeC),
            _ => None,
        }
    }
}

/// Mirrors `VNErrorCode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(i32)]
pub enum VisionErrorCode {
    TuriCore = -1,
    Success = 0,
    RequestCancelled = 1,
    InvalidFormat = 2,
    OperationFailed = 3,
    OutOfBounds = 4,
    InvalidOption = 5,
    Io = 6,
    MissingOption = 7,
    NotImplemented = 8,
    Internal = 9,
    OutOfMemory = 10,
    Unknown = 11,
    InvalidOperation = 12,
    InvalidImage = 13,
    InvalidArgument = 14,
    InvalidModel = 15,
    UnsupportedRevision = 16,
    DataUnavailable = 17,
    TimeStampNotFound = 18,
    UnsupportedRequest = 19,
    Timeout = 20,
    UnsupportedComputeStage = 21,
    UnsupportedComputeDevice = 22,
}

impl VisionErrorCode {
    pub const ALL: &'static [Self] = &[
        Self::TuriCore,
        Self::Success,
        Self::RequestCancelled,
        Self::InvalidFormat,
        Self::OperationFailed,
        Self::OutOfBounds,
        Self::InvalidOption,
        Self::Io,
        Self::MissingOption,
        Self::NotImplemented,
        Self::Internal,
        Self::OutOfMemory,
        Self::Unknown,
        Self::InvalidOperation,
        Self::InvalidImage,
        Self::InvalidArgument,
        Self::InvalidModel,
        Self::UnsupportedRevision,
        Self::DataUnavailable,
        Self::TimeStampNotFound,
        Self::UnsupportedRequest,
        Self::Timeout,
        Self::UnsupportedComputeStage,
        Self::UnsupportedComputeDevice,
    ];

    #[must_use]
    pub const fn as_raw(self) -> i32 {
        self as i32
    }

    #[must_use]
    pub const fn from_raw(raw: i32) -> Option<Self> {
        match raw {
            -1 => Some(Self::TuriCore),
            0 => Some(Self::Success),
            1 => Some(Self::RequestCancelled),
            2 => Some(Self::InvalidFormat),
            3 => Some(Self::OperationFailed),
            4 => Some(Self::OutOfBounds),
            5 => Some(Self::InvalidOption),
            6 => Some(Self::Io),
            7 => Some(Self::MissingOption),
            8 => Some(Self::NotImplemented),
            9 => Some(Self::Internal),
            10 => Some(Self::OutOfMemory),
            11 => Some(Self::Unknown),
            12 => Some(Self::InvalidOperation),
            13 => Some(Self::InvalidImage),
            14 => Some(Self::InvalidArgument),
            15 => Some(Self::InvalidModel),
            16 => Some(Self::UnsupportedRevision),
            17 => Some(Self::DataUnavailable),
            18 => Some(Self::TimeStampNotFound),
            19 => Some(Self::UnsupportedRequest),
            20 => Some(Self::Timeout),
            21 => Some(Self::UnsupportedComputeStage),
            22 => Some(Self::UnsupportedComputeDevice),
            _ => None,
        }
    }
}

/// Mirrors `VNErrorDomain`.
pub const VISION_ERROR_DOMAIN: &str = "com.apple.Vision";

extern "C" {
    static VNVisionVersionNumber: f64;
}

/// Return the linked Vision framework version number.
#[must_use]
pub fn vision_version_number() -> f64 {
    // SAFETY: `VNVisionVersionNumber` is a valid extern static provided by the Vision framework.
    unsafe { VNVisionVersionNumber }
}
