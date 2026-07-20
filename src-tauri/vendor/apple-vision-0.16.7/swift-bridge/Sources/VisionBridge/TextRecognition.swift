// OCR bridge backed by VNRecognizeTextRequest.

import AppKit
import CoreGraphics
import CoreImage
import CoreML
import CoreVideo
import Foundation
import ImageIO
import Vision

// MARK: - Public OCR entry point (file path)

/// Run text recognition on the image at `path` and write the observations
/// into a heap-allocated array. The Rust caller takes ownership of the
/// returned pointer and frees it via `vn_recognized_text_free`.
@_cdecl("vn_recognize_text_in_path")
public func vn_recognize_text_in_path(
    _ path: UnsafePointer<CChar>,
    _ recognitionLevel: Int32,
    _ usesLanguageCorrection: Bool,
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
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    return runOCR(
        handler: handler,
        recognitionLevel: recognitionLevel,
        usesLanguageCorrection: usesLanguageCorrection,
        outArray: outArray,
        outCount: outCount,
        outErrorMessage: outErrorMessage
    )
}

// MARK: - Public OCR entry point (CVPixelBuffer)

/// Run text recognition on a CVPixelBuffer. `pixelBufferPtr` is a raw
/// CVPixelBufferRef obtained from apple_cf::cv::CVPixelBuffer::as_ptr(),
/// from a videotoolbox decoder, screencapturekit, or any other capture
/// source. No bytes are copied; Vision reads the buffer in place.
@_cdecl("vn_recognize_text_in_pixel_buffer")
public func vn_recognize_text_in_pixel_buffer(
    _ pixelBufferPtr: UnsafeMutableRawPointer,
    _ recognitionLevel: Int32,
    _ usesLanguageCorrection: Bool,
    _ outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outCount: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let pixelBuffer = Unmanaged<CVPixelBuffer>.fromOpaque(pixelBufferPtr).takeUnretainedValue()
    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
    return runOCR(
        handler: handler,
        recognitionLevel: recognitionLevel,
        usesLanguageCorrection: usesLanguageCorrection,
        outArray: outArray,
        outCount: outCount,
        outErrorMessage: outErrorMessage
    )
}

/// Shared OCR driver — runs the request and packs results.
private func runOCR(
    handler: VNImageRequestHandler,
    recognitionLevel: Int32,
    usesLanguageCorrection: Bool,
    outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    outCount: UnsafeMutablePointer<Int>,
    outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel =
        recognitionLevel == 1 ? .accurate : .fast
    request.usesLanguageCorrection = usesLanguageCorrection

    do {
        try handler.perform([request])
    } catch {
        outErrorMessage?.pointee = ffiString(
            "VNImageRequestHandler.perform failed: \(error.localizedDescription)"
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
    let buffer = UnsafeMutablePointer<VNRecognizedTextRaw>.allocate(capacity: count)
    for (i, observation) in results.enumerated() {
        let candidate = observation.topCandidates(1).first
        let text = candidate?.string ?? ""
        let confidence = candidate?.confidence ?? observation.confidence
        let bbox = observation.boundingBox
        buffer.advanced(by: i).initialize(to: VNRecognizedTextRaw(
            text: ffiString(text),
            confidence: confidence,
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

@_cdecl("vn_recognized_text_free")
public func vn_recognized_text_free(
    _ array: UnsafeMutableRawPointer?,
    _ count: Int
) {
    guard let array = array else { return }
    let typed = array.assumingMemoryBound(to: VNRecognizedTextRaw.self)
    for i in 0..<count {
        if let text = typed.advanced(by: i).pointee.text {
            free(text)
        }
    }
    typed.deallocate()
}
