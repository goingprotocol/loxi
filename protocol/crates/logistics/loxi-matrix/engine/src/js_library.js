mergeInto(LibraryManager.library, {
    rust_lazy_fs_read: function (pathPtr, offsetLow, offsetHigh, length, bufferPtr) {
        // Forward calls to the Module method if defined
        if (Module['rust_lazy_fs_read']) {
            return Module['rust_lazy_fs_read'](pathPtr, offsetLow, offsetHigh, length, bufferPtr);
        }
        if (typeof rust_lazy_fs_read === 'function') {
            return rust_lazy_fs_read(pathPtr, offsetLow, offsetHigh, length, bufferPtr);
        }
        console.error("rust_lazy_fs_read not linked from JS!");
        return -1;
    }
});
