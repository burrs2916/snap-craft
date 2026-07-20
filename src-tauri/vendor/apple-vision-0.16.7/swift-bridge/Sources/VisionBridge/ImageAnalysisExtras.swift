// Additional text/saliency/mask bridges added in the v0.13 coverage sweep.

import AppKit
import CoreGraphics
import CoreImage
import CoreML
import CoreVideo
import Foundation
import ImageIO
import Vision

// MARK: - Text rectangles (region-only, no OCR)

@_cdecl("vn_detect_text_rectangles_in_path")
public func vn_detect_text_rectangles_in_path(
    _ path: UnsafePointer<CChar>,
    _ reports_character_boxes: Bool,
    _ out_rects_raw: UnsafeMutableRawPointer,
    _ out_count: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let out_rects = out_rects_raw.assumingMemoryBound(to: UnsafeMutablePointer<VNSimpleRectRaw>?.self)
    out_rects.pointee = nil
    out_count.pointee = 0
    let p = String(cString: path)
    guard let img = loadCGImage(path: p) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(p)")
        return VN_IMAGE_LOAD_FAILED
    }
    let req = VNDetectTextRectanglesRequest()
    req.reportCharacterBoxes = reports_character_boxes
    let handler = VNImageRequestHandler(cgImage: img, options: [:])
    do { try handler.perform([req]) } catch {
        outErrorMessage?.pointee = ffiString("text rectangles request failed: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
    guard let obs = req.results else { return VN_OK }
    var rects = obs.map { mkRect($0.boundingBox, $0.confidence) }
    if rects.isEmpty { return VN_OK }
    let buf = UnsafeMutablePointer<VNSimpleRectRaw>.allocate(capacity: rects.count)
    buf.initialize(from: &rects, count: rects.count)
    out_rects.pointee = buf
    out_count.pointee = rects.count
    return VN_OK
}

@frozen
public struct VNTextObservationRaw {
    public var bbox_x: Double
    public var bbox_y: Double
    public var bbox_w: Double
    public var bbox_h: Double
    public var confidence: Float
    public var _pad: Float
    public var character_boxes: UnsafeMutablePointer<VNSimpleRectRaw>?
    public var character_box_count: Int
}

@_cdecl("vn_detect_text_observations_in_path")
public func vn_detect_text_observations_in_path(
    _ path: UnsafePointer<CChar>,
    _ reports_character_boxes: Bool,
    _ roiX: Double,
    _ roiY: Double,
    _ roiW: Double,
    _ roiH: Double,
    _ hasRegionOfInterest: Bool,
    _ preferBackgroundProcessing: Bool,
    _ usesCPUOnly: Bool,
    _ revision: Int,
    _ hasRevision: Bool,
    _ out_observations_raw: UnsafeMutableRawPointer,
    _ out_count: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let outObservations = out_observations_raw.assumingMemoryBound(to: UnsafeMutablePointer<VNTextObservationRaw>?.self)
    outObservations.pointee = nil
    out_count.pointee = 0
    let p = String(cString: path)
    guard let img = loadCGImage(path: p) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(p)")
        return VN_IMAGE_LOAD_FAILED
    }
    let req = VNDetectTextRectanglesRequest()
    req.reportCharacterBoxes = reports_character_boxes
    applyImageBasedRequestConfig(
        req,
        roiX: roiX,
        roiY: roiY,
        roiW: roiW,
        roiH: roiH,
        hasRegionOfInterest: hasRegionOfInterest,
        preferBackgroundProcessing: preferBackgroundProcessing,
        usesCPUOnly: usesCPUOnly,
        revision: revision,
        hasRevision: hasRevision
    )
    let handler = VNImageRequestHandler(cgImage: img, options: [:])
    do { try handler.perform([req]) } catch {
        outErrorMessage?.pointee = ffiString("text observations request failed: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
    guard let observations = req.results, !observations.isEmpty else { return VN_OK }
    let buffer = UnsafeMutablePointer<VNTextObservationRaw>.allocate(capacity: observations.count)
    for (index, observation) in observations.enumerated() {
        let characterBoxes = observation.characterBoxes ?? []
        let characterBuffer: UnsafeMutablePointer<VNSimpleRectRaw>?
        if characterBoxes.isEmpty {
            characterBuffer = nil
        } else {
            let allocated = UnsafeMutablePointer<VNSimpleRectRaw>.allocate(capacity: characterBoxes.count)
            var raws = characterBoxes.map { mkRect($0.boundingBox, $0.confidence) }
            allocated.initialize(from: &raws, count: raws.count)
            characterBuffer = allocated
        }
        let bbox = observation.boundingBox
        buffer.advanced(by: index).initialize(to: VNTextObservationRaw(
            bbox_x: Double(bbox.origin.x),
            bbox_y: Double(bbox.origin.y),
            bbox_w: Double(bbox.size.width),
            bbox_h: Double(bbox.size.height),
            confidence: observation.confidence,
            _pad: 0,
            character_boxes: characterBuffer,
            character_box_count: characterBoxes.count
        ))
    }
    outObservations.pointee = buffer
    out_count.pointee = observations.count
    return VN_OK
}

@_cdecl("vn_text_observations_free")
public func vn_text_observations_free(_ ptr: UnsafeMutableRawPointer?, _ count: Int) {
    guard let ptr else { return }
    let typed = ptr.assumingMemoryBound(to: VNTextObservationRaw.self)
    for index in 0..<count {
        typed[index].character_boxes?.deallocate()
    }
    typed.deinitialize(count: count)
    typed.deallocate()
}

// MARK: - Objectness-based saliency

@_cdecl("vn_objectness_saliency_in_path")
public func vn_objectness_saliency_in_path(
    _ path: UnsafePointer<CChar>,
    _ out_rects_raw: UnsafeMutableRawPointer,
    _ out_count: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let out_rects = out_rects_raw.assumingMemoryBound(to: UnsafeMutablePointer<VNSimpleRectRaw>?.self)
    out_rects.pointee = nil
    out_count.pointee = 0
    let p = String(cString: path)
    guard let img = loadCGImage(path: p) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(p)")
        return VN_IMAGE_LOAD_FAILED
    }
    let req = VNGenerateObjectnessBasedSaliencyImageRequest()
    let handler = VNImageRequestHandler(cgImage: img, options: [:])
    do { try handler.perform([req]) } catch {
        outErrorMessage?.pointee = ffiString("objectness saliency request failed: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
    guard let obs = req.results?.first, let regions = obs.salientObjects else { return VN_OK }
    var rects = regions.map { mkRect($0.boundingBox, $0.confidence) }
    if rects.isEmpty { return VN_OK }
    let buf = UnsafeMutablePointer<VNSimpleRectRaw>.allocate(capacity: rects.count)
    buf.initialize(from: &rects, count: rects.count)
    out_rects.pointee = buf
    out_count.pointee = rects.count
    return VN_OK
}

// MARK: - Person instance mask (macOS 14+)

/// Writes a packed 8-bit per-pixel mask. Caller must `free()` the buffer.
@_cdecl("vn_person_instance_mask_in_path")
public func vn_person_instance_mask_in_path(
    _ path: UnsafePointer<CChar>,
    _ out_width: UnsafeMutablePointer<Int>,
    _ out_height: UnsafeMutablePointer<Int>,
    _ out_bytes_per_row: UnsafeMutablePointer<Int>,
    _ out_data: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    out_width.pointee = 0
    out_height.pointee = 0
    out_bytes_per_row.pointee = 0
    out_data.pointee = nil
    if #available(macOS 14.0, *) {
        let p = String(cString: path)
        guard let img = loadCGImage(path: p) else {
            outErrorMessage?.pointee = ffiString("could not load image at \(p)")
            return VN_IMAGE_LOAD_FAILED
        }
        let req = VNGeneratePersonInstanceMaskRequest()
        let handler = VNImageRequestHandler(cgImage: img, options: [:])
        do { try handler.perform([req]) } catch {
            outErrorMessage?.pointee = ffiString("person instance mask request failed: \(error.localizedDescription)")
            return VN_REQUEST_FAILED
        }
        guard let obs = req.results?.first else { return VN_OK }
        let allInstances = obs.allInstances
        if allInstances.isEmpty { return VN_OK }
        guard let pb = try? obs.generateScaledMaskForImage(forInstances: allInstances, from: handler) else {
            return VN_OK
        }
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        let w = CVPixelBufferGetWidth(pb)
        let h = CVPixelBufferGetHeight(pb)
        let bpr = CVPixelBufferGetBytesPerRow(pb)
        guard let base = CVPixelBufferGetBaseAddress(pb) else { return VN_OK }
        let size = bpr * h
        let data = UnsafeMutablePointer<UInt8>.allocate(capacity: size)
        data.initialize(from: base.assumingMemoryBound(to: UInt8.self), count: size)
        out_width.pointee = w
        out_height.pointee = h
        out_bytes_per_row.pointee = bpr
        out_data.pointee = data
        return VN_OK
    }
    return VN_REQUEST_FAILED
}

@_cdecl("vn_mask_buffer_free")
public func vn_mask_buffer_free(_ ptr: UnsafeMutablePointer<UInt8>?, _ size: Int) {
    guard let ptr = ptr else { return }
    ptr.deinitialize(count: size)
    ptr.deallocate()
}
