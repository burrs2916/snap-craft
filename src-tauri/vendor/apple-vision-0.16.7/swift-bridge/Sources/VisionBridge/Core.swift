// Shared Vision bridge helpers and OCR raw types.

import AppKit
import CoreGraphics
import CoreImage
import CoreML
import CoreVideo
import Foundation
import ImageIO
import Vision

// MARK: - Status codes (mirrored in src/error.rs)

internal let VN_OK: Int32 = 0
internal let VN_INVALID_ARGUMENT: Int32 = -1
internal let VN_IMAGE_LOAD_FAILED: Int32 = -2
internal let VN_REQUEST_FAILED: Int32 = -3
internal let VN_UNKNOWN: Int32 = -99

// MARK: - String helpers

@_cdecl("vn_string_free")
public func vn_string_free(_ str: UnsafeMutablePointer<CChar>?) {
    guard let str = str else { return }
    free(str)
}

internal func ffiString(_ s: String) -> UnsafeMutablePointer<CChar>? {
    return s.withCString { strdup($0) }
}

// MARK: - FFI Result Types

/// One recognised text observation. Matches `RecognizedTextRaw` in src/ffi/mod.rs.
@frozen
public struct VNRecognizedTextRaw {
    /// NUL-terminated UTF-8 string (heap-allocated; caller frees with vn_string_free).
    public var text: UnsafeMutablePointer<CChar>?
    /// VNConfidence in 0.0...1.0
    public var confidence: Float
    /// Bounding box in normalised (0...1) image coordinates with origin at
    /// bottom-left (Vision convention).
    public var bbox_x: Double
    public var bbox_y: Double
    public var bbox_w: Double
    public var bbox_h: Double
}

/// Recognition mode — fast-but-less-accurate vs accurate-but-slower.
public enum VNRecognitionLevelRaw: Int32 {
    case fast = 0
    case accurate = 1
}

// MARK: - Image loading

/// Load an image from a file URL into a CGImage. Supports any format
/// CoreGraphics' ImageIO can read (PNG/JPEG/HEIC/TIFF/...).
internal func loadCGImage(path: String) -> CGImage? {
    let url = URL(fileURLWithPath: path)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        return nil
    }
    return image
}
