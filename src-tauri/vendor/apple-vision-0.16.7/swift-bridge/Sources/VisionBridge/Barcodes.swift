// Barcode-detection bridge backed by VNDetectBarcodesRequest.

import AppKit
import CoreGraphics
import CoreImage
import CoreML
import CoreVideo
import Foundation
import ImageIO
import Vision

// MARK: - Barcode detection (v0.4)

/// One detected barcode. Matches `DetectedBarcodeRaw` in src/ffi/mod.rs.
@frozen
public struct VNDetectedBarcodeRaw {
    /// Payload string the barcode decodes to (e.g. URL, text). May be nil.
    public var payload: UnsafeMutablePointer<CChar>?
    /// Symbology identifier (e.g. "VNBarcodeSymbologyQR", "VNBarcodeSymbologyEAN13").
    public var symbology: UnsafeMutablePointer<CChar>?
    /// Confidence in 0.0...1.0.
    public var confidence: Float
    /// Bounding box in normalised (0..1) image coordinates, origin
    /// bottom-left (Vision convention).
    public var bbox_x: Double
    public var bbox_y: Double
    public var bbox_w: Double
    public var bbox_h: Double
}

@_cdecl("vn_detect_barcodes_in_path")
public func vn_detect_barcodes_in_path(
    _ imagePath: UnsafePointer<CChar>,
    _ outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outCount: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let pathStr = String(cString: imagePath)
    let url = URL(fileURLWithPath: pathStr)
    guard let ciImage = CIImage(contentsOf: url) else {
        outErrorMessage?.pointee = ffiString("Could not load image at \(pathStr)")
        return VN_IMAGE_LOAD_FAILED
    }
    let handler = VNImageRequestHandler(ciImage: ciImage, options: [:])
    return runBarcodeRequest(handler: handler, outArray: outArray, outCount: outCount, outErrorMessage: outErrorMessage)
}

private func runBarcodeRequest(
    handler: VNImageRequestHandler,
    outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    outCount: UnsafeMutablePointer<Int>,
    outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let request = VNDetectBarcodesRequest()
    do {
        try handler.perform([request])
    } catch {
        outErrorMessage?.pointee = ffiString("VNImageRequestHandler.perform(barcodes) failed: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
    guard let results = request.results, !results.isEmpty else {
        outArray.pointee = nil
        outCount.pointee = 0
        return VN_OK
    }
    let count = results.count
    let buffer = UnsafeMutablePointer<VNDetectedBarcodeRaw>.allocate(capacity: count)
    for (i, observation) in results.enumerated() {
        let payload = observation.payloadStringValue ?? ""
        let symbology = observation.symbology.rawValue
        let bbox = observation.boundingBox
        buffer.advanced(by: i).initialize(to: VNDetectedBarcodeRaw(
            payload: ffiString(payload),
            symbology: ffiString(symbology),
            confidence: observation.confidence,
            bbox_x: Double(bbox.origin.x),
            bbox_y: Double(bbox.origin.y),
            bbox_w: Double(bbox.size.width),
            bbox_h: Double(bbox.size.height)
        ))
    }
    outArray.pointee = UnsafeMutableRawPointer(buffer)
    outCount.pointee = count
    return VN_OK
}

@_cdecl("vn_detected_barcodes_free")
public func vn_detected_barcodes_free(_ array: UnsafeMutableRawPointer?, _ count: Int) {
    guard let array = array else { return }
    let typed = array.assumingMemoryBound(to: VNDetectedBarcodeRaw.self)
    for i in 0..<count {
        let entry = typed.advanced(by: i).pointee
        if let p = entry.payload { free(p) }
        if let p = entry.symbology { free(p) }
    }
    typed.deallocate()
}
