// Face-detection bridge backed by VNDetectFaceRectanglesRequest.

import AppKit
import CoreGraphics
import CoreImage
import CoreML
import CoreVideo
import Foundation
import ImageIO
import Vision

// MARK: - Face Detection

/// One detected face. Layout-compatible with `DetectedFaceRaw` in Rust.
@frozen
public struct VNDetectedFaceRaw {
    /// Bounding box in normalised image coordinates (Vision convention,
    /// origin bottom-left).
    public var bbox_x: Double
    public var bbox_y: Double
    public var bbox_w: Double
    public var bbox_h: Double
    /// Face confidence in 0...1.
    public var confidence: Float
    /// Roll/yaw/pitch in radians; NaN if unavailable.
    public var roll: Float
    public var yaw: Float
    public var pitch: Float
}

@_cdecl("vn_detect_faces_in_path")
public func vn_detect_faces_in_path(
    _ path: UnsafePointer<CChar>,
    _ outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outCount: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let pathStr = String(cString: path)
    guard let cgImage = loadCGImage(path: pathStr) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(pathStr)")
        outArray.pointee = nil
        outCount.pointee = 0
        return VN_IMAGE_LOAD_FAILED
    }
    return runFaceDetect(
        handler: VNImageRequestHandler(cgImage: cgImage, options: [:]),
        outArray: outArray,
        outCount: outCount,
        outErrorMessage: outErrorMessage
    )
}

@_cdecl("vn_detect_faces_in_pixel_buffer")
public func vn_detect_faces_in_pixel_buffer(
    _ pixelBufferPtr: UnsafeMutableRawPointer,
    _ outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outCount: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let pixelBuffer = Unmanaged<CVPixelBuffer>.fromOpaque(pixelBufferPtr).takeUnretainedValue()
    return runFaceDetect(
        handler: VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:]),
        outArray: outArray,
        outCount: outCount,
        outErrorMessage: outErrorMessage
    )
}

private func runFaceDetect(
    handler: VNImageRequestHandler,
    outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    outCount: UnsafeMutablePointer<Int>,
    outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let request = VNDetectFaceRectanglesRequest()
    do {
        try handler.perform([request])
    } catch {
        outErrorMessage?.pointee = ffiString(
            "VNImageRequestHandler.perform(face) failed: \(error.localizedDescription)"
        )
        outArray.pointee = nil
        outCount.pointee = 0
        return VN_REQUEST_FAILED
    }

    guard let results = request.results, !results.isEmpty else {
        outArray.pointee = nil
        outCount.pointee = 0
        return VN_OK
    }

    let count = results.count
    let buffer = UnsafeMutablePointer<VNDetectedFaceRaw>.allocate(capacity: count)
    for (i, observation) in results.enumerated() {
        let bbox = observation.boundingBox
        // roll/yaw/pitch are NSNumber? — convert to Float, NaN if missing.
        let roll = (observation.roll?.floatValue) ?? .nan
        let yaw = (observation.yaw?.floatValue) ?? .nan
        let pitch = (observation.pitch?.floatValue) ?? .nan
        buffer.advanced(by: i).initialize(to: VNDetectedFaceRaw(
            bbox_x: Double(bbox.origin.x),
            bbox_y: Double(bbox.origin.y),
            bbox_w: Double(bbox.size.width),
            bbox_h: Double(bbox.size.height),
            confidence: observation.confidence,
            roll: roll,
            yaw: yaw,
            pitch: pitch
        ))
    }
    outArray.pointee = UnsafeMutableRawPointer(buffer)
    outCount.pointee = count
    return VN_OK
}

@_cdecl("vn_detected_faces_free")
public func vn_detected_faces_free(_ array: UnsafeMutableRawPointer?, _ count: Int) {
    guard let array = array else { return }
    let typed = array.assumingMemoryBound(to: VNDetectedFaceRaw.self)
    typed.deallocate()
    _ = count // kept for symmetry with the OCR free fn
}
