cmake_minimum_required(VERSION 3.22)
project(GmfDumperNative)

# The native part of GmfDumper: a UE4SS C++ mod, loaded as Mods/GmfDumper/dlls/main.dll.
# It links UE4SS's C++ interface, so one build matches exactly one UE4SS build.
# scripts/build-dumper.mjs configures and builds this project.

# The RE-UE4SS source tree, with its submodules, at the commit of the UE4SS build to match.
set(GMF_UE4SS_SOURCE_DIR "" CACHE PATH "RE-UE4SS source tree with submodules")

if(NOT EXISTS "${GMF_UE4SS_SOURCE_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "UE4SS source not found at '${GMF_UE4SS_SOURCE_DIR}'. Pass -DGMF_UE4SS_SOURCE_DIR=<checkout>.")
endif()

add_subdirectory("${GMF_UE4SS_SOURCE_DIR}" ue4ss)

set(TARGET GmfDumper)

# UE4SS's BP SDK generator has no Lua function and is not exported from UE4SS.dll, so its
# sources are compiled into this DLL. They are MIT licensed, like the rest of UE4SS.
set(GMF_UE4SS_SDKGEN_SOURCES
    "${GMF_UE4SS_SOURCE_DIR}/UE4SS/src/SDKGenerator/SDKGenerator.cpp"
    "${GMF_UE4SS_SOURCE_DIR}/UE4SS/src/SDKGenerator/Common.cpp"
)

add_library(${TARGET} SHARED
    src/dllmain.cpp
    src/LuaBindings.cpp
    src/GmfCommon.cpp
    src/Fs.cpp
    src/Assets.cpp
    src/TMapOverrides.cpp
    src/Reflection.cpp
    src/Names.cpp
    src/Scripts.cpp
    src/Actors.cpp
    src/ValueWriter.cpp
    src/Values.cpp
    src/BPSDK.cpp
    ${GMF_UE4SS_SDKGEN_SOURCES}
)

target_include_directories(${TARGET} PRIVATE
    src
    # Holds SDKGenerator/BuiltinSDKBackend.hpp, which UE4SS generates at configure time.
    "${CMAKE_BINARY_DIR}/ue4ss/UE4SS/generated"
)
target_link_libraries(${TARGET} PUBLIC UE4SS)
set_target_properties(${TARGET} PROPERTIES OUTPUT_NAME "main")
