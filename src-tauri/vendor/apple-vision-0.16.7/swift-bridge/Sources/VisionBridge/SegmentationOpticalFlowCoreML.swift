// Segmentation, optical-flow, and Core ML bridges.

import AppKit
import CoreGraphics
import CoreImage
import CoreML
import CoreVideo
import Foundation
import ImageIO
import Vision

// MARK: - Person segmentation (v0.10)

@frozen
public struct VNSegmentationMaskRaw {
    public var width: Int
    public var height: Int
    public var bytes_per_row: Int
    /// Newly-allocated buffer of `height * bytes_per_row` bytes.
    /// Caller frees via `vn_segmentation_mask_free`.
    public var bytes: UnsafeMutableRawPointer?
}

private func copyCVPixelBufferToBytes(_ buffer: CVPixelBuffer) -> VNSegmentationMaskRaw {
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else {
        return VNSegmentationMaskRaw(width: width, height: height,
                                     bytes_per_row: bytesPerRow, bytes: nil)
    }
    let size = height * bytesPerRow
    let out = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 8)
    memcpy(out, base, size)
    return VNSegmentationMaskRaw(
        width: width, height: height,
        bytes_per_row: bytesPerRow, bytes: out)
}

/// Quality levels for person segmentation: 0=fast, 1=balanced, 2=accurate.
@_cdecl("vn_generate_person_segmentation_in_path")
public func vn_generate_person_segmentation_in_path(
    _ path: UnsafePointer<CChar>,
    _ qualityLevel: Int32,
    _ outMaskRaw: UnsafeMutableRawPointer,
    _ outHasValue: UnsafeMutablePointer<Bool>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let outMask = outMaskRaw.assumingMemoryBound(to: VNSegmentationMaskRaw.self)
    let pathStr = String(cString: path)
    guard let cgImage = loadCGImage(path: pathStr) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(pathStr)")
        outHasValue.pointee = false
        return VN_IMAGE_LOAD_FAILED
    }
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    let request = VNGeneratePersonSegmentationRequest()
    if let lvl = VNGeneratePersonSegmentationRequest.QualityLevel(rawValue: UInt(qualityLevel)) {
        request.qualityLevel = lvl
    }
    // 8bppONE mask format (kCVPixelFormatType_OneComponent8).
    request.outputPixelFormat = 0x4f6e6538 // 'One8'
    do { try handler.perform([request]) } catch {
        outErrorMessage?.pointee = ffiString("person segmentation failed: \(error.localizedDescription)")
        outHasValue.pointee = false
        return VN_REQUEST_FAILED
    }
    guard let obs = request.results?.first else {
        outHasValue.pointee = false
        return VN_OK
    }
    outMask.pointee = copyCVPixelBufferToBytes(obs.pixelBuffer)
    outHasValue.pointee = true
    return VN_OK
}

@_cdecl("vn_generate_foreground_instance_mask_in_path")
public func vn_generate_foreground_instance_mask_in_path(
    _ path: UnsafePointer<CChar>,
    _ outMaskRaw: UnsafeMutableRawPointer,
    _ outInstanceCount: UnsafeMutablePointer<Int>,
    _ outHasValue: UnsafeMutablePointer<Bool>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let outMask = outMaskRaw.assumingMemoryBound(to: VNSegmentationMaskRaw.self)
    if #unavailable(macOS 14.0) {
        outErrorMessage?.pointee = ffiString("foreground instance mask requires macOS 14+")
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
    if #available(macOS 14.0, *) {
        let request = VNGenerateForegroundInstanceMaskRequest()
        do { try handler.perform([request]) } catch {
            outErrorMessage?.pointee = ffiString("foreground mask failed: \(error.localizedDescription)")
            outHasValue.pointee = false
            return VN_REQUEST_FAILED
        }
        guard let obs = request.results?.first else {
            outHasValue.pointee = false
            outInstanceCount.pointee = 0
            return VN_OK
        }
        outMask.pointee = copyCVPixelBufferToBytes(obs.instanceMask)
        outInstanceCount.pointee = obs.allInstances.count
        outHasValue.pointee = true
    }
    return VN_OK
}

@_cdecl("vn_segmentation_mask_free")
public func vn_segmentation_mask_free(_ mask: UnsafeMutableRawPointer) {
    let typed = mask.assumingMemoryBound(to: VNSegmentationMaskRaw.self)
    if let b = typed.pointee.bytes {
        b.deallocate()
        typed.pointee.bytes = nil
    }
}

// MARK: - Optical flow (v0.11)
//
// Two-frame request: frame A -> handler, frame B -> targeted request.
// computationAccuracy: 0=low, 1=medium, 2=high, 3=veryHigh.

@_cdecl("vn_generate_optical_flow_in_paths")
public func vn_generate_optical_flow_in_paths(
    _ pathA: UnsafePointer<CChar>,
    _ pathB: UnsafePointer<CChar>,
    _ computationAccuracy: Int32,
    _ outMaskRaw: UnsafeMutableRawPointer,
    _ outHasValue: UnsafeMutablePointer<Bool>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let outMask = outMaskRaw.assumingMemoryBound(to: VNSegmentationMaskRaw.self)
    let aStr = String(cString: pathA)
    let bStr = String(cString: pathB)
    guard let aImage = loadCGImage(path: aStr) else {
        outErrorMessage?.pointee = ffiString("could not load image A at \(aStr)")
        outHasValue.pointee = false
        return VN_IMAGE_LOAD_FAILED
    }
    guard let bImage = loadCGImage(path: bStr) else {
        outErrorMessage?.pointee = ffiString("could not load image B at \(bStr)")
        outHasValue.pointee = false
        return VN_IMAGE_LOAD_FAILED
    }
    let handler = VNImageRequestHandler(cgImage: aImage, options: [:])
    let request = VNGenerateOpticalFlowRequest(targetedCGImage: bImage, options: [:])
    if let lvl = VNGenerateOpticalFlowRequest.ComputationAccuracy(rawValue: UInt(computationAccuracy)) {
        request.computationAccuracy = lvl
    }
    do { try handler.perform([request]) } catch {
        outErrorMessage?.pointee = ffiString("optical flow request failed: \(error.localizedDescription)")
        outHasValue.pointee = false
        return VN_REQUEST_FAILED
    }
    guard let obs = request.results?.first else {
        outHasValue.pointee = false
        return VN_OK
    }
    outMask.pointee = copyCVPixelBufferToBytes(obs.pixelBuffer)
    outHasValue.pointee = true
    return VN_OK
}

// MARK: - CoreML request (v0.12)

@frozen
public struct VNCoreMLFeatureValueRaw {
    public var feature_name: UnsafeMutablePointer<CChar>?
    public var type_name: UnsafeMutablePointer<CChar>?
    public var kind: Int32
    public var int64_value: Int64
    public var double_value: Double
    public var string_value: UnsafeMutablePointer<CChar>?
    public var multi_array_shape: UnsafeMutablePointer<Int>?
    public var multi_array_shape_count: Int
    public var multi_array_values: UnsafeMutablePointer<Double>?
    public var multi_array_value_count: Int
}

internal func loadVisionCoreMLModel(
    modelPath: String,
    inputImageFeatureName: String?
) throws -> VNCoreMLModel {
    let modelURL = URL(fileURLWithPath: modelPath)
    let compiledURL = try MLModel.compileModel(at: modelURL)
    let mlModel = try MLModel(contentsOf: compiledURL)
    let vnModel = try VNCoreMLModel(for: mlModel)
    if let inputImageFeatureName, #available(macOS 10.15, *) {
        vnModel.inputImageFeatureName = inputImageFeatureName
    }
    return vnModel
}

internal func applyCoreMLRequestConfig(
    _ request: VNCoreMLRequest,
    imageCropAndScaleOption: Int32,
    roiX: Double,
    roiY: Double,
    roiW: Double,
    roiH: Double,
    hasRegionOfInterest: Bool,
    preferBackgroundProcessing: Bool,
    usesCPUOnly: Bool,
    revision: Int,
    hasRevision: Bool
) {
    if let option = VNImageCropAndScaleOption(rawValue: UInt(imageCropAndScaleOption)) {
        request.imageCropAndScaleOption = option
    }
    applyImageBasedRequestConfig(
        request,
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
}

internal func copyMultiArrayValues(_ multiArray: MLMultiArray) -> [Double] {
    let count = multiArray.count
    if #available(macOS 26.0, *), multiArray.dataType == .int8 {  // .int8 added macOS 26.0
        let ptr = multiArray.dataPointer.bindMemory(to: Int8.self, capacity: count)
        return (0..<count).map { Double(ptr[$0]) }
    }
    switch multiArray.dataType {
    case .double:
        let ptr = multiArray.dataPointer.bindMemory(to: Double.self, capacity: count)
        return Array(UnsafeBufferPointer(start: ptr, count: count))
    case .float32:
        let ptr = multiArray.dataPointer.bindMemory(to: Float.self, capacity: count)
        return (0..<count).map { Double(ptr[$0]) }
    case .int32:
        let ptr = multiArray.dataPointer.bindMemory(to: Int32.self, capacity: count)
        return (0..<count).map { Double(ptr[$0]) }
    case .float16:
        let ptr = multiArray.dataPointer.bindMemory(to: UInt16.self, capacity: count)
        // Portable IEEE-754 binary16 -> binary64 conversion.
        // Deliberately avoids `Float16(bitPattern:)` AND `Double(Float16)`,
        // which are only available on the newest SDKs and break the crate's
        // `swift build` on CI runners provisioned with older SDKs
        // (e.g. Xcode 16 / macOS 15). Uses only `Float(bitPattern:)` +
        // `Double(Float)`, stable on every SDK.
        return (0..<count).map { Double(halfToFloatBits(ptr[$0])) }
    @unknown default:
        return []
    }
}

// IEEE 754 binary16 (UInt16 bit-pattern) -> Float32, via pure bit manipulation.
// Does NOT depend on any `Float16` Swift API, so it compiles on every macOS SDK
// (Xcode 16 / macOS 15 through Xcode 26 / macOS 26 and beyond).
private func halfToFloatBits(_ h: UInt16) -> Float {
    let sign = UInt32(h >> 15) << 31
    let exp = (h >> 10) & 0x1F
    let mant = UInt32(h & 0x3FF)
    var bits: UInt32
    if exp == 0 {
        if mant == 0 {
            bits = sign
        } else {
            // Subnormal half -> normalize into a float32.
            var e: UInt32 = 1
            var m = mant
            while (m & 0x400) == 0 {
                m <<= 1
                e -= 1
            }
            m &= 0x3FF
            bits = sign | ((127 - 15 + e) << 23) | (m << 13)
        }
    } else if exp == 0x1F {
        // Inf / NaN.
        bits = sign | (0xFF << 23) | (mant << 13)
    } else {
        // Normalized half.
        bits = sign | ((UInt32(exp) - 15 + 127) << 23) | (mant << 13)
    }
    return Float(bitPattern: bits)
}

@_cdecl("vn_coreml_classify_in_path")
public func vn_coreml_classify_in_path(
    _ path: UnsafePointer<CChar>,
    _ model_path: UnsafePointer<CChar>,
    _ outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outCount: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    return vn_coreml_request_classify_in_path(
        path,
        model_path,
        nil,
        false,
        0,
        0,
        0,
        1,
        1,
        false,
        false,
        false,
        0,
        false,
        outArray,
        outCount,
        outErrorMessage
    )
}

@_cdecl("vn_coreml_request_classify_in_path")
public func vn_coreml_request_classify_in_path(
    _ path: UnsafePointer<CChar>,
    _ model_path: UnsafePointer<CChar>,
    _ input_image_feature_name: UnsafePointer<CChar>?,
    _ has_input_image_feature_name: Bool,
    _ imageCropAndScaleOption: Int32,
    _ roiX: Double,
    _ roiY: Double,
    _ roiW: Double,
    _ roiH: Double,
    _ hasRegionOfInterest: Bool,
    _ preferBackgroundProcessing: Bool,
    _ usesCPUOnly: Bool,
    _ revision: Int,
    _ hasRevision: Bool,
    _ outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outCount: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let pathStr = String(cString: path)
    let modelStr = String(cString: model_path)
    let inputImageFeatureName = has_input_image_feature_name && input_image_feature_name != nil
        ? String(cString: input_image_feature_name!)
        : nil
    outArray.pointee = nil
    outCount.pointee = 0
    guard let cgImage = loadCGImage(path: pathStr) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(pathStr)")
        return VN_IMAGE_LOAD_FAILED
    }
    let request: VNCoreMLRequest
    do {
        let vnModel = try loadVisionCoreMLModel(modelPath: modelStr, inputImageFeatureName: inputImageFeatureName)
        request = VNCoreMLRequest(model: vnModel)
    } catch {
        outErrorMessage?.pointee = ffiString("CoreML model load failed: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
    applyCoreMLRequestConfig(
        request,
        imageCropAndScaleOption: imageCropAndScaleOption,
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
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do { try handler.perform([request]) } catch {
        outErrorMessage?.pointee = ffiString("CoreML perform: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
    guard let results = request.results as? [VNClassificationObservation], !results.isEmpty else {
        return VN_OK
    }
    let count = results.count
    let buf = UnsafeMutablePointer<VNClassificationRaw>.allocate(capacity: count)
    for (i, obs) in results.enumerated() {
        buf.advanced(by: i).initialize(to: VNClassificationRaw(
            identifier: ffiString(obs.identifier),
            confidence: obs.confidence))
    }
    outArray.pointee = UnsafeMutableRawPointer(buf)
    outCount.pointee = count
    return VN_OK
}

@_cdecl("vn_coreml_feature_value_in_path")
public func vn_coreml_feature_value_in_path(
    _ path: UnsafePointer<CChar>,
    _ model_path: UnsafePointer<CChar>,
    _ input_image_feature_name: UnsafePointer<CChar>?,
    _ has_input_image_feature_name: Bool,
    _ imageCropAndScaleOption: Int32,
    _ roiX: Double,
    _ roiY: Double,
    _ roiW: Double,
    _ roiH: Double,
    _ hasRegionOfInterest: Bool,
    _ preferBackgroundProcessing: Bool,
    _ usesCPUOnly: Bool,
    _ revision: Int,
    _ hasRevision: Bool,
    _ outFeatureRaw: UnsafeMutableRawPointer,
    _ outHasValue: UnsafeMutablePointer<Bool>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let outFeature = outFeatureRaw.assumingMemoryBound(to: VNCoreMLFeatureValueRaw.self)
    let pathStr = String(cString: path)
    let modelStr = String(cString: model_path)
    let inputImageFeatureName = has_input_image_feature_name && input_image_feature_name != nil
        ? String(cString: input_image_feature_name!)
        : nil
    outHasValue.pointee = false
    outFeature.pointee = VNCoreMLFeatureValueRaw(
        feature_name: nil,
        type_name: nil,
        kind: 0,
        int64_value: 0,
        double_value: 0,
        string_value: nil,
        multi_array_shape: nil,
        multi_array_shape_count: 0,
        multi_array_values: nil,
        multi_array_value_count: 0
    )
    guard let cgImage = loadCGImage(path: pathStr) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(pathStr)")
        return VN_IMAGE_LOAD_FAILED
    }
    let request: VNCoreMLRequest
    do {
        let vnModel = try loadVisionCoreMLModel(modelPath: modelStr, inputImageFeatureName: inputImageFeatureName)
        request = VNCoreMLRequest(model: vnModel)
    } catch {
        outErrorMessage?.pointee = ffiString("CoreML model load failed: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
    applyCoreMLRequestConfig(
        request,
        imageCropAndScaleOption: imageCropAndScaleOption,
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
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do { try handler.perform([request]) } catch {
        outErrorMessage?.pointee = ffiString("CoreML perform: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
    guard let observation = request.results?.first as? VNCoreMLFeatureValueObservation else {
        return VN_OK
    }
    let featureValue = observation.featureValue
    if #available(macOS 10.15, *) {
        outFeature.pointee.feature_name = ffiString(observation.featureName)
    }
    switch featureValue.type {
    case .int64:
        outFeature.pointee.kind = 1
        outFeature.pointee.type_name = ffiString("int64")
        outFeature.pointee.int64_value = featureValue.int64Value
    case .double:
        outFeature.pointee.kind = 2
        outFeature.pointee.type_name = ffiString("double")
        outFeature.pointee.double_value = featureValue.doubleValue
    case .string:
        outFeature.pointee.kind = 3
        outFeature.pointee.type_name = ffiString("string")
        outFeature.pointee.string_value = ffiString(featureValue.stringValue)
    case .multiArray:
        outFeature.pointee.kind = 4
        outFeature.pointee.type_name = ffiString("multiArray")
        if let multiArray = featureValue.multiArrayValue {
            var shape = multiArray.shape.map { $0.intValue }
            if !shape.isEmpty {
                let shapeBuffer = UnsafeMutablePointer<Int>.allocate(capacity: shape.count)
                shapeBuffer.initialize(from: &shape, count: shape.count)
                outFeature.pointee.multi_array_shape = shapeBuffer
                outFeature.pointee.multi_array_shape_count = shape.count
            }
            var values = copyMultiArrayValues(multiArray)
            if !values.isEmpty {
                let valueBuffer = UnsafeMutablePointer<Double>.allocate(capacity: values.count)
                valueBuffer.initialize(from: &values, count: values.count)
                outFeature.pointee.multi_array_values = valueBuffer
                outFeature.pointee.multi_array_value_count = values.count
            }
        }
    case .invalid, .image, .dictionary, .sequence, .state:
        outFeature.pointee.kind = 0
        outFeature.pointee.type_name = ffiString("unsupported")
    @unknown default:
        outFeature.pointee.kind = 0
        outFeature.pointee.type_name = ffiString("unknown")
    }
    outHasValue.pointee = true
    return VN_OK
}

@_cdecl("vn_coreml_feature_value_free")
public func vn_coreml_feature_value_free(_ featureRaw: UnsafeMutableRawPointer) {
    let feature = featureRaw.assumingMemoryBound(to: VNCoreMLFeatureValueRaw.self)
    if let featureName = feature.pointee.feature_name {
        free(featureName)
        feature.pointee.feature_name = nil
    }
    if let typeName = feature.pointee.type_name {
        free(typeName)
        feature.pointee.type_name = nil
    }
    if let stringValue = feature.pointee.string_value {
        free(stringValue)
        feature.pointee.string_value = nil
    }
    feature.pointee.multi_array_shape?.deallocate()
    feature.pointee.multi_array_shape = nil
    feature.pointee.multi_array_shape_count = 0
    feature.pointee.multi_array_values?.deallocate()
    feature.pointee.multi_array_values = nil
    feature.pointee.multi_array_value_count = 0
}
