// Async Vision bridge thunks — DispatchQueue-backed Future helpers.
// Each @_cdecl function dispatches the synchronous Vision API on a global
// concurrent queue and fires a C callback with (result_ptr, error_cstr, ctx).

import Foundation
import Vision

// MARK: - Shared result containers

/// Heap-allocated result for array-type async Vision calls.
/// Freed by `vn_async_array_result_free`.
@frozen
public struct VNAsyncArrayResultRaw {
    public var array: UnsafeMutableRawPointer?
    public var count: Int
}

/// Free a `VNAsyncArrayResultRaw*` allocated by the async thunks.
@_cdecl("vn_async_array_result_free")
public func vn_async_array_result_free(_ ptr: UnsafeMutableRawPointer) {
    ptr.assumingMemoryBound(to: VNAsyncArrayResultRaw.self).deallocate()
}

/// Heap-allocated result for segmentation async calls.
/// The caller copies the bytes and frees the container via `vn_async_seg_result_free`.
@frozen
public struct VNAsyncSegResultRaw {
    public var width: Int
    public var height: Int
    public var bytes_per_row: Int
    public var bytes: UnsafeMutableRawPointer?
}

/// Free a `VNAsyncSegResultRaw*` and its copied mask bytes.
@_cdecl("vn_async_seg_result_free")
public func vn_async_seg_result_free(_ ptr: UnsafeMutableRawPointer) {
    let typed = ptr.assumingMemoryBound(to: VNAsyncSegResultRaw.self)
    if let bytes = typed.pointee.bytes {
        bytes.deallocate()
        typed.pointee.bytes = nil
    }
    typed.deallocate()
}

// MARK: - Text recognition async

@_cdecl("vn_recognize_text_in_path_async")
public func vn_recognize_text_in_path_async(
    _ path: UnsafePointer<CChar>,
    _ recognitionLevel: Int32,
    _ usesLanguageCorrection: Bool,
    _ cb: @escaping @convention(c) (UnsafeRawPointer?, UnsafePointer<CChar>?, UnsafeMutableRawPointer) -> Void,
    _ ctx: UnsafeMutableRawPointer
) {
    let pathStr = String(cString: path)
    let level = recognitionLevel
    let languageCorrection = usesLanguageCorrection
    DispatchQueue.global(qos: .userInitiated).async {
        var outArray: UnsafeMutableRawPointer? = nil
        var outCount: Int = 0
        var outError: UnsafeMutablePointer<CChar>? = nil
        let status = pathStr.withCString { pathC in
            vn_recognize_text_in_path(pathC, level, languageCorrection, &outArray, &outCount, &outError)
        }
        if status != VN_OK {
            if let err = outError {
                cb(nil, UnsafePointer(err), ctx)
                free(err)
            } else {
                "vn_recognize_text_in_path failed with status \(status)".withCString { cb(nil, $0, ctx) }
            }
            return
        }
        let resultPtr = UnsafeMutablePointer<VNAsyncArrayResultRaw>.allocate(capacity: 1)
        resultPtr.initialize(to: VNAsyncArrayResultRaw(array: outArray, count: outCount))
        cb(UnsafeRawPointer(resultPtr), nil, ctx)
    }
}

// MARK: - Face detection async

@_cdecl("vn_detect_faces_in_path_async")
public func vn_detect_faces_in_path_async(
    _ path: UnsafePointer<CChar>,
    _ cb: @escaping @convention(c) (UnsafeRawPointer?, UnsafePointer<CChar>?, UnsafeMutableRawPointer) -> Void,
    _ ctx: UnsafeMutableRawPointer
) {
    let pathStr = String(cString: path)
    DispatchQueue.global(qos: .userInitiated).async {
        var outArray: UnsafeMutableRawPointer? = nil
        var outCount: Int = 0
        var outError: UnsafeMutablePointer<CChar>? = nil
        let status = pathStr.withCString { pathC in
            vn_detect_faces_in_path(pathC, &outArray, &outCount, &outError)
        }
        if status != VN_OK {
            if let err = outError {
                cb(nil, UnsafePointer(err), ctx)
                free(err)
            } else {
                "vn_detect_faces_in_path failed with status \(status)".withCString { cb(nil, $0, ctx) }
            }
            return
        }
        let resultPtr = UnsafeMutablePointer<VNAsyncArrayResultRaw>.allocate(capacity: 1)
        resultPtr.initialize(to: VNAsyncArrayResultRaw(array: outArray, count: outCount))
        cb(UnsafeRawPointer(resultPtr), nil, ctx)
    }
}

// MARK: - Barcode detection async

@_cdecl("vn_detect_barcodes_in_path_async")
public func vn_detect_barcodes_in_path_async(
    _ path: UnsafePointer<CChar>,
    _ cb: @escaping @convention(c) (UnsafeRawPointer?, UnsafePointer<CChar>?, UnsafeMutableRawPointer) -> Void,
    _ ctx: UnsafeMutableRawPointer
) {
    let pathStr = String(cString: path)
    DispatchQueue.global(qos: .userInitiated).async {
        var outArray: UnsafeMutableRawPointer? = nil
        var outCount: Int = 0
        var outError: UnsafeMutablePointer<CChar>? = nil
        let status = pathStr.withCString { pathC in
            vn_detect_barcodes_in_path(pathC, &outArray, &outCount, &outError)
        }
        if status != VN_OK {
            if let err = outError {
                cb(nil, UnsafePointer(err), ctx)
                free(err)
            } else {
                "vn_detect_barcodes_in_path failed with status \(status)".withCString { cb(nil, $0, ctx) }
            }
            return
        }
        let resultPtr = UnsafeMutablePointer<VNAsyncArrayResultRaw>.allocate(capacity: 1)
        resultPtr.initialize(to: VNAsyncArrayResultRaw(array: outArray, count: outCount))
        cb(UnsafeRawPointer(resultPtr), nil, ctx)
    }
}

// MARK: - Person segmentation async

@_cdecl("vn_generate_person_segmentation_async")
public func vn_generate_person_segmentation_async(
    _ path: UnsafePointer<CChar>,
    _ qualityLevel: Int32,
    _ cb: @escaping @convention(c) (UnsafeRawPointer?, UnsafePointer<CChar>?, UnsafeMutableRawPointer) -> Void,
    _ ctx: UnsafeMutableRawPointer
) {
    let pathStr = String(cString: path)
    let quality = qualityLevel
    DispatchQueue.global(qos: .userInitiated).async {
        var outMask = VNSegmentationMaskRaw(width: 0, height: 0, bytes_per_row: 0, bytes: nil)
        var hasValue = false
        var outError: UnsafeMutablePointer<CChar>? = nil
        let status = pathStr.withCString { pathC in
            vn_generate_person_segmentation_in_path(pathC, quality, &outMask, &hasValue, &outError)
        }
        if status != VN_OK {
            if let err = outError {
                cb(nil, UnsafePointer(err), ctx)
                free(err)
            } else {
                "vn_generate_person_segmentation_in_path failed with status \(status)".withCString { cb(nil, $0, ctx) }
            }
            return
        }
        if !hasValue || outMask.bytes == nil {
            "segmentation produced no mask".withCString { cb(nil, $0, ctx) }
            return
        }
        let resultPtr = UnsafeMutablePointer<VNAsyncSegResultRaw>.allocate(capacity: 1)
        resultPtr.initialize(to: VNAsyncSegResultRaw(
            width: outMask.width,
            height: outMask.height,
            bytes_per_row: outMask.bytes_per_row,
            bytes: outMask.bytes
        ))
        cb(UnsafeRawPointer(resultPtr), nil, ctx)
    }
}
