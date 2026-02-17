FROM --platform=linux/amd64 emscripten/emsdk:3.1.51

# Install build tools
RUN apt-get update && apt-get install -y \
    git \
    cmake \
    automake \
    libtool \
    pkg-config \
    python3 \
    wget \
    curl \
    build-essential \
    zlib1g-dev \
    liblz4-dev \
    libboost-all-dev \
    libprotobuf-dev \
    protobuf-compiler

WORKDIR /app

# 1. Build PROTOBUF for HOST (needed for protoc compiler)
RUN git clone -b v21.12 --depth 1 https://github.com/protocolbuffers/protobuf.git protobuf-host \
    && cd protobuf-host \
    && git submodule update --init --recursive \
    && ./autogen.sh \
    && ./configure \
    && make -j$(nproc) \
    && make install \
    && ldconfig

# Set Global Flags for WASM Builds (WASM32)
ENV CFLAGS="-Wno-error"
ENV CXXFLAGS="-Wno-error"
ENV LDFLAGS="-Wno-error"

# 2. Build PROTOBUF for WASM (target)
RUN git clone -b v21.12 --depth 1 https://github.com/protocolbuffers/protobuf.git protobuf-wasm \
    && cd protobuf-wasm \
    && git submodule update --init --recursive \
    && mkdir build-wasm \
    && cd build-wasm \
    && emcmake cmake .. -Dprotobuf_BUILD_TESTS=OFF -DCMAKE_INSTALL_PREFIX=/app/wasm-libs -DCMAKE_CXX_FLAGS="-Wno-error" -DCMAKE_C_FLAGS="-Wno-error" \
    && emmake make -j$(nproc) \
    && emmake make install

# 2.5 Build ZLIB for WASM (Required because system zlib is x86, not WASM)
RUN wget https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz \
    && tar xzf zlib-1.3.1.tar.gz \
    && cd zlib-1.3.1 \
    && emcmake cmake . -DCMAKE_INSTALL_PREFIX=/app/wasm-libs -DCMAKE_CXX_FLAGS="-Wno-error" -DCMAKE_C_FLAGS="-Wno-error" \
    && emmake make install

# 2.6 Build LZ4 for WASM
RUN wget https://github.com/lz4/lz4/archive/refs/tags/v1.9.4.tar.gz \
    && tar xzf v1.9.4.tar.gz \
    && cd lz4-1.9.4 \
    && emmake make lib CFLAGS="-Wno-error" \
    && mkdir -p /app/wasm-libs/include /app/wasm-libs/lib \
    && cp lib/*.h /app/wasm-libs/include/ \
    && cp lib/liblz4.a /app/wasm-libs/lib/

# 2.7 Build GEOS for WASM
RUN wget http://download.osgeo.org/geos/geos-3.11.2.tar.bz2 \
    && tar xjf geos-3.11.2.tar.bz2 \
    && cd geos-3.11.2 \
    && mkdir build \
    && cd build \
    && emcmake cmake .. -DCMAKE_INSTALL_PREFIX=/app/wasm-libs -DBUILD_SHARED_LIBS=OFF -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF -DCMAKE_CXX_FLAGS="-Wno-error" -DCMAKE_C_FLAGS="-Wno-error" \
    && emmake make -j$(nproc) \
    && emmake make install

# 2.8 Build SQLite3 for WASM
RUN wget https://sqlite.org/2023/sqlite-autoconf-3410200.tar.gz \
    && tar xzf sqlite-autoconf-3410200.tar.gz \
    && cd sqlite-autoconf-3410200 \
    && emconfigure ./configure --prefix=/app/wasm-libs --host=wasm32-unknown-emscripten --disable-shared CFLAGS="-Wno-error" \
    && emmake make -j$(nproc) \
    && emmake make install

# 2.9 Download Clean Boost (Required to avoid /usr/include pollution)
WORKDIR /app
RUN wget -O boost.tar.gz https://sourceforge.net/projects/boost/files/boost/1.81.0/boost_1_81_0.tar.gz/download \
    && tar xzf boost.tar.gz \
    && mv boost_1_81_0 boost

# 3. Clone Valhalla
WORKDIR /app
RUN git clone --recurse-submodules https://github.com/valhalla/valhalla.git

# 4. Configure Valhalla WASM
WORKDIR /app/valhalla

# HACK: Mock PkgConfig targets manually because we disabled pkg-config
RUN echo 'add_library(PkgConfig::ZLIB STATIC IMPORTED GLOBAL)' > mock_targets.cmake \
    && echo 'set_target_properties(PkgConfig::ZLIB PROPERTIES IMPORTED_LOCATION /app/wasm-libs/lib/libz.a)' >> mock_targets.cmake \
    && echo 'set_target_properties(PkgConfig::ZLIB PROPERTIES INTERFACE_INCLUDE_DIRECTORIES /app/wasm-libs/include)' >> mock_targets.cmake \
    && echo 'add_library(PkgConfig::LZ4 STATIC IMPORTED GLOBAL)' >> mock_targets.cmake \
    && echo 'set_target_properties(PkgConfig::LZ4 PROPERTIES IMPORTED_LOCATION /app/wasm-libs/lib/liblz4.a)' >> mock_targets.cmake \
    && echo 'set_target_properties(PkgConfig::LZ4 PROPERTIES INTERFACE_INCLUDE_DIRECTORIES /app/wasm-libs/include)' >> mock_targets.cmake

# Patch CMakeLists.txt (Main and Submodules):
# 1. Disable pkg_check_modules for ZLIB/LZ4 in main file
# 2. Inject mock targets into main file (At line 2, to be safe)
# 3. Patch submodule/CMakeLists to remove pkg_check_modules calls too
RUN sed -i 's/pkg_check_modules(ZLIB/# pkg_check_modules(ZLIB/g' CMakeLists.txt \
    && sed -i 's/pkg_check_modules(LZ4/# pkg_check_modules(LZ4/g' CMakeLists.txt \
    && sed -i 's/pkg_check_modules(ZLIB/# pkg_check_modules(ZLIB/g' src/baldr/CMakeLists.txt \
    && sed -i 's/pkg_check_modules(LZ4/# pkg_check_modules(LZ4/g' src/skadi/CMakeLists.txt \
    && echo "set(ZLIB_FOUND TRUE)" >> CMakeLists.txt \
    && echo "set(LZ4_FOUND TRUE)" >> CMakeLists.txt \
    && echo "set(ZLIB_FOUND TRUE)" >> CMakeLists.txt \
    && echo "set(LZ4_FOUND TRUE)" >> CMakeLists.txt \
    && echo "" > src/bindings/python/CMakeLists.txt \
    && sed -i '2r mock_targets.cmake' CMakeLists.txt \
    # 4. FORCE IGNORE ERRORS/EXPERIMENTAL WARNINGS
    && sed -i '1i add_compile_options(-Wno-experimental -Wno-error)' CMakeLists.txt \
    && find . -name "CMakeLists.txt" -print0 | xargs -0 sed -i 's/-Werror//g'

RUN mkdir build
WORKDIR /app/valhalla/build

RUN emcmake cmake .. \
    -DENABLE_NODE_BINDING=OFF \
    -DENABLE_PYTHON_BINDING=OFF \
    -DENABLE_SERVICES=OFF \
    -DENABLE_DATA_TOOLS=OFF \
    -DENABLE_TESTS=OFF \
    -DENABLE_BENCHMARKS=OFF \
    -DENABLE_HTTP=OFF \
    -DCMAKE_BUILD_TYPE=Release \
    -DBOOST_ROOT=/app/boost \
    -DBoost_INCLUDE_DIR=/app/boost \
    -DBoost_NO_BOOST_CMAKE=ON \
    -DBoost_NO_SYSTEM_PATHS=ON \
    -DProtobuf_INCLUDE_DIR=/app/wasm-libs/include \
    -DProtobuf_LIBRARY=/app/wasm-libs/lib/libprotobuf.a \
    -DPROTOC_EXECUTABLE=/usr/local/bin/protoc \
    -DZLIB_INCLUDE_DIR=/app/wasm-libs/include \
    -DZLIB_LIBRARY=/app/wasm-libs/lib/libz.a \
    -DLZ4_INCLUDE_DIR=/app/wasm-libs/include \
    -DLZ4_LIBRARY=/app/wasm-libs/lib/liblz4.a \
    -DGEOS_INCLUDE_DIR=/app/wasm-libs/include \
    -DGEOS_LIBRARY=/app/wasm-libs/lib/libgeos_c.a \
    -DCMAKE_CXX_FLAGS="-Wno-error" \
    -DCMAKE_C_FLAGS="-Wno-error" \
    -DCMAKE_EXE_LINKER_FLAGS="-Wno-error"

# 5. Build Valhalla Lib
RUN emmake make -j$(nproc) valhalla
