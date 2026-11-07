---
name: unreal.ue4ss.cpp
title: UE4SS C++ mod layout
description: Build a UE4SS C++ mod against the UE4SS SDK and deploy its DLL to the Mods folder with the companion metadata.
engine: unreal
tags: [ue4ss, cpp, sdk, hooks, build]
confidence: verified
sources: [UE4SS documentation, RE-UE4SS GitHub repository, earlier Unreal modding framework notes]
---

# UE4SS C++ mod layout

A C++ mod is a DLL loaded by UE4SS. It links the UE4SS SDK and registers hooks
from its module entry point.

## Layout

```
ue4ss/Mods/MyMod/
  enabled.txt
  dlls/main.dll
```

- `dlls/main.dll` is the default DLL path.
- The build needs the UE4SS SDK headers and a matching ABI. A mismatch usually
  crashes the game at load.

## Build

1. Use the SDK version that matches the installed UE4SS version.
2. Build for the game's architecture, usually x64.
3. Copy the DLL (and `enabled.txt`, when present) through the deploy operation so
   an existing mod is backed up first.
4. Read `UE4SS.log` for load errors.

## Hooks

- Register hook callbacks from `on_unreal_init` with the UE4SS C++ hook API.
- `StaticFindObject` resolves a UObject by path.
- A signature scan is more stable than a hard-coded address after a game update.

## Pitfalls

- The MSVC runtime version matters. A missing runtime shows as a load failure,
  not a compile error.
- Do not mix headers from two UE4SS versions.
- A crash without a Lua trace is often a C++ ABI mismatch. Check the UE4SS
  version before reading the game code.

## C++ API and build reference

This section follows the RE-UE4SS C++ guides. It documents the `start_mod` and `uninstall_mod` exports and the `CppUserModBase` lifecycle.

### When to use C++ instead of Lua

Default to Lua (`unreal.ue4ss.lua`): faster to write, hot-reloads, no toolchain. Use C++ only for native performance (tight per-frame loops, heavy math), direct vtable or member-offset access (including non-`UFUNCTION` methods), or engine-level hooks on arbitrary native functions and UE4SS internals (GUI, signature-scan results). The model shared with Lua is in `unreal.reflection`.

### `CppUserModBase` lifecycle

Every native mod derives from `RC::CppUserModBase` (`#include <Mod/CppUserModBase.hpp>`) and overrides only the hooks it needs; all default to no-ops, in typical firing order:

- `on_dll_load(StringViewType dll_name)`: for every DLL UE4SS loads, other mods' DLLs included.
- `on_program_start()`: UE4SS program startup.
- `on_unreal_init()`: the `Unreal` module is initialized; nothing in `RC::Unreal` is usable before it. Do `StaticFindObject` lookups and register hooks here.
- `on_ui_init()`: the UI module is initialized; call `UE4SS_ENABLE_IMGUI()` here before using ImGui.
- `on_cpp_mods_loaded()`: after every C++ mod has loaded.
- `on_update()`: every engine tick on the game thread; no heavy work.
- `on_lua_start(...)` / `on_lua_stop(...)`: when a Lua mod starts or stops (an overload for every Lua mod, one for a Lua mod of the same name), giving the Lua, main, async and hook `LuaMadeSimple::Lua` instances; only for direct interop with Lua mods.
- `render_tab()`: legacy per-mod tab render; prefer `register_tab`.

In the constructor set the public `StringType` members `ModName` (match the folder name under `Mods/`), `ModVersion`, `ModDescription`, `ModAuthors`, optionally `ModIntendedSDKVersion`.

### Mandatory exports

UE4SS resolves two `extern "C"` exports by name; wrong names or signatures mean the mod cannot load:

```c++
#define MOD_API __declspec(dllexport)
extern "C" {
    MOD_API RC::CppUserModBase* start_mod() { return new MyAwesomeMod(); }
    MOD_API void uninstall_mod(RC::CppUserModBase* mod) { delete mod; }
}
```

`CppUserModBase.hpp` does not include `DynamicOutput.hpp`; add `#include <DynamicOutput/DynamicOutput.hpp>` and call `RC::Output::send<RC::LogLevel::Verbose>(...)` for log output. The scaffold from `unreal.scaffold --input type=cpp` has both exports, the include and the `RC::` prefixes. Source: https://docs.ue4ss.com/guides/creating-a-c++-mod.html

Build settings that must match UE4SS: C++23 (`set_languages("cxx23")`), the dynamic MSVC runtime (`set_runtimes("MD")`), x64 on Windows, and a link against the `UE4SS` library (`add_links("UE4SS")`). The scaffold's `xmake.lua` sets all four. A build of the scaffold against a UE4SS SDK has not been run in this repository; treat the first build as the check.

### Build with xmake against the UE4SS source tree

Shipped mods under `cppmods/` (`EventViewerMod`, `KismetDebuggerMod`) and the scaffold use **xmake**:

```lua
local projectName = "KismetDebuggerMod"
target(projectName)
    add_rules("ue4ss.mod")
    add_includedirs("include")
    add_files("src/dllmain.cpp", "src/KismetDebugger.cpp")
```

`add_rules("ue4ss.mod")` sets `kind = shared`, `languages = cxx23`, exceptions, links the `UE4SS` target and registers an `on_install` step that deploys the DLL. `cppmods/xmake.lua` is a flat list of `includes("<ModName>")` lines; a new mod adds its own. From an RE-UE4SS checkout with submodules (`git submodule update --init --recursive`):

1. Put the mod folder under `cppmods/<ModName>/` with its own `xmake.lua`.
2. Add `includes("<ModName>")` to `cppmods/xmake.lua`.
3. Build with `gmf run unreal.build` (xmake, returns the exact command, exit code and log tail), or `xmake build <ModName>` from the RE-UE4SS root.
4. Deploy with `gmf run unreal.deploy`, or `xmake install <ModName> --installdir="<Game>/Binaries/Win64"`, whose `on_install` copies to `<installdir>/Mods/<ModName>/dlls/main.dll` and writes `enabled.txt` if absent.

A CMake path also exists (`creating-a-c++-mod.md`: top-level `CMakeLists.txt` with `add_subdirectory(RE-UE4SS)` and `add_subdirectory(MyAwesomeMod)`, each mod linking `PUBLIC UE4SS`) but xmake is what the real tree uses.

Installing without a source build: create `Mods/<ModName>/dlls/`, put the DLL there as `main.dll` (UE4SS falls back to `<ModName>.dll`), then add `<ModName> : 1` to `Mods/mods.txt` **above** the `Keybinds` line, or drop an empty `enabled.txt` in the mod folder (load-order agnostic).

### Accessing properties and functions

Never hand-roll structs mimicking game memory or hardcode offsets; both break on updates. Use reflection:

- `UObject::GetValuePtrByPropertyNameInChain<T>(STR("PropertyName"))` returns `T*`, searching the whole class hierarchy; preferred.
- `UObject::GetValuePtrByPropertyName<T>(...)` checks only the innermost class (for `APlayerController` it ignores `AController`).
- For nested `FStructProperty` values with no wrapper type: `auto Prop = static_cast<FStructProperty*>(Owner->GetPropertyByNameInChain(STR("Field")));`, then `UStruct* Inner = Prop->GetStruct();`, then `auto ValuePtr = Prop->ContainerPtrToValuePtr<void>(Owner);`, repeating `Inner->GetPropertyByNameInChain(...)` per level. `ContainerPtrToValuePtr<T>` returns `T*`; write through it (`*AssetName = FName(STR("New Value"), FNAME_Add);`).

For invoking a UFunction when property access is not enough, see `docs/cpp-api/bp-macros.md` (`UE_BEGIN_SCRIPT_FUNCTION_BODY`, `UE_BEGIN_NATIVE_FUNCTION_BODY`, `UE_COPY_PROPERTY`).

### Optional ImGui tab

From the constructor: `register_tab(STR("Tab Name"), [](CppUserModBase* instance) { ... })` (protected on `CppUserModBase`; preferred, auto-cleaned on destruction; `dynamic_cast` the instance to reach members), or the lower-level `UE4SSProgram::get_program().add_gui_tab(shared_ptr<GUI::GUITab>)`, where you must call `remove_gui_tab(...)` in the destructor or it crashes on unload. Either way `UE4SS_ENABLE_IMGUI()` must run in `on_ui_init()` before any ImGui call, or it crashes.

### Debugging

`#include <Helpers/Debug.hpp>` and call `RC::await_debugger()` to block until a debugger attaches, then attach your IDE to the game process. It is `[[deprecated]]` on purpose to force a warning: never ship it in a release. Log with `Output::send<LogLevel::Verbose>(STR("..."), ...)` (`std::format` `{}` placeholders, not `printf`), which routes to the log file and both consoles.
