// Feature-print, human-rectangle, and aesthetics bridges.

import AppKit
import CoreGraphics
import CoreImage
import CoreML
import CoreVideo
import Foundation
import ImageIO
import Vision

// MARK: - Image feature print (v0.8)

@frozen
public struct VNFeaturePrintRaw {
    /// Element type — 1 = Float, 2 = Double.
    public var element_type: Int32
    public var element_count: Int
    /// Pointer to a freshly-allocated buffer of `element_count * 4` (Float)
    /// or `* 8` (Double) bytes. Caller frees via `vn_feature_print_free`.
    public var bytes: UnsafeMutableRawPointer?
}

@_cdecl("vn_generate_image_feature_print_in_path")
public func vn_generate_image_feature_print_in_path(
    _ path: UnsafePointer<CChar>,
    _ outFeature: UnsafeMutableRawPointer,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let outTyped = outFeature.assumingMemoryBound(to: VNFeaturePrintRaw.self)
    let pathStr = String(cString: path)
    guard let cgImage = loadCGImage(path: pathStr) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(pathStr)")
        return VN_IMAGE_LOAD_FAILED
    }
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    let request = VNGenerateImageFeaturePrintRequest()
    do { try handler.perform([request]) } catch {
        outErrorMessage?.pointee = ffiString("feature print request failed: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
    guard let obs = request.results?.first else {
        outTyped.pointee = VNFeaturePrintRaw(element_type: 0, element_count: 0, bytes: nil)
        return VN_OK
    }
    let data = obs.data
    let bytes = UnsafeMutableRawPointer.allocate(byteCount: data.count, alignment: 8)
    data.copyBytes(to: bytes.assumingMemoryBound(to: UInt8.self), count: data.count)
    outTyped.pointee = VNFeaturePrintRaw(
        element_type: Int32(obs.elementType.rawValue),
        element_count: obs.elementCount,
        bytes: bytes
    )
    return VN_OK
}

@_cdecl("vn_feature_print_free")
public func vn_feature_print_free(_ feature: UnsafeMutableRawPointer) {
    let typed = feature.assumingMemoryBound(to: VNFeaturePrintRaw.self)
    guard let bytes = typed.pointee.bytes else { return }
    bytes.deallocate()
    typed.pointee.bytes = nil
}

// MARK: - Detect humans (v0.8)

@frozen
public struct VNHumanObservationRaw {
    public var bbox_x: Double
    public var bbox_y: Double
    public var bbox_w: Double
    public var bbox_h: Double
    public var confidence: Float
    public var upper_body_only: Bool
}

@_cdecl("vn_detect_human_rectangles_in_path")
public func vn_detect_human_rectangles_in_path(
    _ path: UnsafePointer<CChar>,
    _ upperBodyOnly: Bool,
    _ outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outCount: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let pathStr = String(cString: path)
    guard let cgImage = loadCGImage(path: pathStr) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(pathStr)")
        outArray.pointee = nil; outCount.pointee = 0
        return VN_IMAGE_LOAD_FAILED
    }
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    let request = VNDetectHumanRectanglesRequest()
    if #available(macOS 12.0, *) {
        request.upperBodyOnly = upperBodyOnly
    }
    do { try handler.perform([request]) } catch {
        outErrorMessage?.pointee = ffiString("human rectangles failed: \(error.localizedDescription)")
        outArray.pointee = nil; outCount.pointee = 0
        return VN_REQUEST_FAILED
    }
    let results = request.results ?? []
    let count = results.count
    if count == 0 { outArray.pointee = nil; outCount.pointee = 0; return VN_OK }
    let buf = UnsafeMutablePointer<VNHumanObservationRaw>.allocate(capacity: count)
    for (i, obs) in results.enumerated() {
        let b = obs.boundingBox
        buf.advanced(by: i).initialize(to: VNHumanObservationRaw(
            bbox_x: Double(b.origin.x),
            bbox_y: Double(b.origin.y),
            bbox_w: Double(b.size.width),
            bbox_h: Double(b.size.height),
            confidence: obs.confidence,
            upper_body_only: upperBodyOnly
        ))
    }
    outArray.pointee = UnsafeMutableRawPointer(buf)
    outCount.pointee = count
    return VN_OK
}

@_cdecl("vn_human_observations_free")
public func vn_human_observations_free(_ array: UnsafeMutableRawPointer?, _ count: Int) {
    guard let array = array else { return }
    let typed = array.assumingMemoryBound(to: VNHumanObservationRaw.self)
    _ = count
    typed.deallocate()
}

// MARK: - Aesthetics + face capture quality (v0.9)

@frozen
public struct VNAestheticsScoresRaw {
    public var overall_score: Float
    public var is_utility: Bool
}

@_cdecl("vn_calculate_aesthetics_scores_in_path")
public func vn_calculate_aesthetics_scores_in_path(
    _ path: UnsafePointer<CChar>,
    _ outScoresRaw: UnsafeMutableRawPointer,
    _ outHasValue: UnsafeMutablePointer<Bool>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let outScores = outScoresRaw.assumingMemoryBound(to: VNAestheticsScoresRaw.self)
    if #unavailable(macOS 15.0) {
        outErrorMessage?.pointee = ffiString("aesthetics scores require macOS 15+")
        outHasValue.pointee = false
        return VN_REQUEST_FAILED
    }
    let pathStr = String(cString: path)
    guard let cgImage = loadCGImage(path: pathStr) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(pathStr)")
        outHasValue.pointee = false
        return VN_IMAGE_LOAD_FAILED
    }
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    if #available(macOS 15.0, *) {
        let request = VNCalculateImageAestheticsScoresRequest()
        do { try handler.perform([request]) } catch {
            outErrorMessage?.pointee = ffiString("aesthetics request failed: \(error.localizedDescription)")
            outHasValue.pointee = false
            return VN_REQUEST_FAILED
        }
        guard let obs = request.results?.first else {
            outHasValue.pointee = false
            return VN_OK
        }
        outScores.pointee = VNAestheticsScoresRaw(
            overall_score: obs.overallScore,
            is_utility: obs.isUtility
        )
        outHasValue.pointee = true
    }
    return VN_OK
}

@frozen
public struct VNFaceQualityRaw {
    public var bbox_x: Double
    public var bbox_y: Double
    public var bbox_w: Double
    public var bbox_h: Double
    public var confidence: Float
    public var capture_quality: Float
    public var has_quality: Bool
}

@_cdecl("vn_detect_face_capture_quality_in_path")
public func vn_detect_face_capture_quality_in_path(
    _ path: UnsafePointer<CChar>,
    _ outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outCount: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let pathStr = String(cString: path)
    guard let cgImage = loadCGImage(path: pathStr) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(pathStr)")
        outArray.pointee = nil; outCount.pointee = 0
        return VN_IMAGE_LOAD_FAILED
    }
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    let request = VNDetectFaceCaptureQualityRequest()
    do { try handler.perform([request]) } catch {
        outErrorMessage?.pointee = ffiString("face quality request failed: \(error.localizedDescription)")
        outArray.pointee = nil; outCount.pointee = 0
        return VN_REQUEST_FAILED
    }
    let results = request.results ?? []
    let count = results.count
    if count == 0 { outArray.pointee = nil; outCount.pointee = 0; return VN_OK }
    let buf = UnsafeMutablePointer<VNFaceQualityRaw>.allocate(capacity: count)
    for (i, obs) in results.enumerated() {
        let b = obs.boundingBox
        let q = obs.faceCaptureQuality
        buf.advanced(by: i).initialize(to: VNFaceQualityRaw(
            bbox_x: Double(b.origin.x),
            bbox_y: Double(b.origin.y),
            bbox_w: Double(b.size.width),
            bbox_h: Double(b.size.height),
            confidence: obs.confidence,
            capture_quality: q ?? 0.0,
            has_quality: q != nil
        ))
    }
    outArray.pointee = UnsafeMutableRawPointer(buf)
    outCount.pointee = count
    return VN_OK
}

@_cdecl("vn_face_quality_observations_free")
public func vn_face_quality_observations_free(_ array: UnsafeMutableRawPointer?, _ count: Int) {
    guard let array = array else { return }
    let typed = array.assumingMemoryBound(to: VNFaceQualityRaw.self)
    _ = count
    typed.deallocate()
}
