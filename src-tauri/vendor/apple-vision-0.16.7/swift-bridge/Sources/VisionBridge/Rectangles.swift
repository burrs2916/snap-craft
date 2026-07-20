// Rectangle, document-segmentation, and horizon bridges.

import AppKit
import CoreGraphics
import CoreImage
import CoreML
import CoreVideo
import Foundation
import ImageIO
import Vision

// MARK: - Detect rectangles + document segmentation (v0.8)

@frozen
public struct VNRectangleObservationRaw {
    public var bbox_x: Double
    public var bbox_y: Double
    public var bbox_w: Double
    public var bbox_h: Double
    public var confidence: Float
    public var tl_x: Double
    public var tl_y: Double
    public var tr_x: Double
    public var tr_y: Double
    public var bl_x: Double
    public var bl_y: Double
    public var br_x: Double
    public var br_y: Double
}

private func emitRectangleObservations(
    _ observations: [VNRectangleObservation]
) -> (UnsafeMutableRawPointer?, Int) {
    let count = observations.count
    if count == 0 { return (nil, 0) }
    let buf = UnsafeMutablePointer<VNRectangleObservationRaw>.allocate(capacity: count)
    for (i, obs) in observations.enumerated() {
        let b = obs.boundingBox
        buf.advanced(by: i).initialize(to: VNRectangleObservationRaw(
            bbox_x: Double(b.origin.x),
            bbox_y: Double(b.origin.y),
            bbox_w: Double(b.size.width),
            bbox_h: Double(b.size.height),
            confidence: obs.confidence,
            tl_x: Double(obs.topLeft.x),
            tl_y: Double(obs.topLeft.y),
            tr_x: Double(obs.topRight.x),
            tr_y: Double(obs.topRight.y),
            bl_x: Double(obs.bottomLeft.x),
            bl_y: Double(obs.bottomLeft.y),
            br_x: Double(obs.bottomRight.x),
            br_y: Double(obs.bottomRight.y)
        ))
    }
    return (UnsafeMutableRawPointer(buf), count)
}

@_cdecl("vn_detect_rectangles_in_path")
public func vn_detect_rectangles_in_path(
    _ path: UnsafePointer<CChar>,
    _ maxObservations: Int,
    _ minimumAspectRatio: Float,
    _ maximumAspectRatio: Float,
    _ minimumSize: Float,
    _ minimumConfidence: Float,
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
    let request = VNDetectRectanglesRequest()
    if maxObservations > 0 { request.maximumObservations = maxObservations }
    if minimumAspectRatio > 0 { request.minimumAspectRatio = VNAspectRatio(minimumAspectRatio) }
    if maximumAspectRatio > 0 { request.maximumAspectRatio = VNAspectRatio(maximumAspectRatio) }
    if minimumSize > 0 { request.minimumSize = minimumSize }
    if minimumConfidence > 0 { request.minimumConfidence = VNConfidence(minimumConfidence) }
    do { try handler.perform([request]) } catch {
        outErrorMessage?.pointee = ffiString("rectangle request failed: \(error.localizedDescription)")
        outArray.pointee = nil; outCount.pointee = 0
        return VN_REQUEST_FAILED
    }
    let results = request.results ?? []
    let (ptr, n) = emitRectangleObservations(results)
    outArray.pointee = ptr
    outCount.pointee = n
    return VN_OK
}

@_cdecl("vn_detect_document_segmentation_in_path")
public func vn_detect_document_segmentation_in_path(
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
    let request = VNDetectDocumentSegmentationRequest()
    do { try handler.perform([request]) } catch {
        outErrorMessage?.pointee = ffiString("document seg request failed: \(error.localizedDescription)")
        outArray.pointee = nil; outCount.pointee = 0
        return VN_REQUEST_FAILED
    }
    let results = request.results ?? []
    let (ptr, n) = emitRectangleObservations(results)
    outArray.pointee = ptr
    outCount.pointee = n
    return VN_OK
}

@_cdecl("vn_rectangle_observations_free")
public func vn_rectangle_observations_free(_ array: UnsafeMutableRawPointer?, _ count: Int) {
    guard let array = array else { return }
    let typed = array.assumingMemoryBound(to: VNRectangleObservationRaw.self)
    _ = count
    typed.deallocate()
}

// MARK: - Detect horizon (v0.8)

/// Returns angle in radians. `has_value` is false when no horizon found.
@_cdecl("vn_detect_horizon_in_path")
public func vn_detect_horizon_in_path(
    _ path: UnsafePointer<CChar>,
    _ out_angle: UnsafeMutablePointer<Double>,
    _ out_has_value: UnsafeMutablePointer<Bool>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let pathStr = String(cString: path)
    guard let cgImage = loadCGImage(path: pathStr) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(pathStr)")
        out_has_value.pointee = false
        return VN_IMAGE_LOAD_FAILED
    }
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    let request = VNDetectHorizonRequest()
    do { try handler.perform([request]) } catch {
        outErrorMessage?.pointee = ffiString("horizon request failed: \(error.localizedDescription)")
        out_has_value.pointee = false
        return VN_REQUEST_FAILED
    }
    guard let obs = request.results?.first else {
        out_has_value.pointee = false
        return VN_OK
    }
    out_angle.pointee = Double(obs.angle)
    out_has_value.pointee = true
    return VN_OK
}
