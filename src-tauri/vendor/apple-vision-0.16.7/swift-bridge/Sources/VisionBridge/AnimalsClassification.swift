// Animal-recognition and classification bridges.

import AppKit
import CoreGraphics
import CoreImage
import CoreML
import CoreVideo
import Foundation
import ImageIO
import Vision

// MARK: - Animal recognition

@frozen
public struct VNRecognizedAnimalRaw {
    public var identifier: UnsafeMutablePointer<CChar>?
    public var confidence: Float
    public var bbox_x: Double
    public var bbox_y: Double
    public var bbox_w: Double
    public var bbox_h: Double
}

@_cdecl("vn_recognize_animals_in_path")
public func vn_recognize_animals_in_path(
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
    let request = VNRecognizeAnimalsRequest()
    do { try handler.perform([request]) } catch {
        outErrorMessage?.pointee = ffiString("animal request failed: \(error.localizedDescription)")
        outArray.pointee = nil; outCount.pointee = 0
        return VN_REQUEST_FAILED
    }
    guard let results = request.results, !results.isEmpty else {
        outArray.pointee = nil; outCount.pointee = 0; return VN_OK
    }
    // Flatten labels: 1 observation -> N labels -> N rows.
    var flat: [VNRecognizedAnimalRaw] = []
    flat.reserveCapacity(results.count)
    for obs in results {
        let bbox = obs.boundingBox
        if let primary = obs.labels.first {
            flat.append(VNRecognizedAnimalRaw(
                identifier: ffiString(primary.identifier),
                confidence: primary.confidence,
                bbox_x: Double(bbox.origin.x),
                bbox_y: Double(bbox.origin.y),
                bbox_w: Double(bbox.size.width),
                bbox_h: Double(bbox.size.height)
            ))
        }
    }
    let count = flat.count
    if count == 0 { outArray.pointee = nil; outCount.pointee = 0; return VN_OK }
    let buf = UnsafeMutablePointer<VNRecognizedAnimalRaw>.allocate(capacity: count)
    for (i, r) in flat.enumerated() { buf.advanced(by: i).initialize(to: r) }
    outArray.pointee = UnsafeMutableRawPointer(buf)
    outCount.pointee = count
    return VN_OK
}

@_cdecl("vn_recognized_animals_free")
public func vn_recognized_animals_free(_ array: UnsafeMutableRawPointer?, _ count: Int) {
    guard let array = array else { return }
    let typed = array.assumingMemoryBound(to: VNRecognizedAnimalRaw.self)
    for i in 0..<count {
        let r = typed.advanced(by: i).pointee
        if let s = r.identifier { free(s) }
    }
    typed.deallocate()
}

// MARK: - Classify image (v0.8)

@frozen
public struct VNClassificationRaw {
    public var identifier: UnsafeMutablePointer<CChar>?
    public var confidence: Float
}

@_cdecl("vn_classify_image_in_path")
public func vn_classify_image_in_path(
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
    let request = VNClassifyImageRequest()
    do { try handler.perform([request]) } catch {
        outErrorMessage?.pointee = ffiString("classify request failed: \(error.localizedDescription)")
        outArray.pointee = nil; outCount.pointee = 0
        return VN_REQUEST_FAILED
    }
    guard let results = request.results, !results.isEmpty else {
        outArray.pointee = nil; outCount.pointee = 0; return VN_OK
    }
    let count = results.count
    let buf = UnsafeMutablePointer<VNClassificationRaw>.allocate(capacity: count)
    for (i, obs) in results.enumerated() {
        buf.advanced(by: i).initialize(to: VNClassificationRaw(
            identifier: ffiString(obs.identifier),
            confidence: obs.confidence
        ))
    }
    outArray.pointee = UnsafeMutableRawPointer(buf)
    outCount.pointee = count
    return VN_OK
}

@_cdecl("vn_classifications_free")
public func vn_classifications_free(_ array: UnsafeMutableRawPointer?, _ count: Int) {
    guard let array = array else { return }
    let typed = array.assumingMemoryBound(to: VNClassificationRaw.self)
    for i in 0..<count {
        if let s = typed.advanced(by: i).pointee.identifier { free(s) }
    }
    typed.deallocate()
}
