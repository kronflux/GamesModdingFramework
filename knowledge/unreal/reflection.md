---
name: unreal.reflection
title: UE object model and runtime reflection through UE4SS Lua
description: What a UObject is in memory, the UClass, UStruct, UScriptStruct and UFunction hierarchy, FName, the property system and enums, and how to walk classes and read and write properties from UE4SS Lua.
engine: unreal
tags: [ue4ss, lua, reflection, uobject, uclass, ustruct, ufunction, property, fname, enum]
confidence: observed
sources: [earlier Unreal modding framework notes]
---

# UE object model and runtime reflection

The mental model behind every UE4SS Lua mod. Do not invent a class, method or global that is not named here or in `unreal.ue4ss.lua.hooking`; UE4SS exposes a curated subset of the engine API. Upstream docs: https://github.com/UE4SS-RE/RE-UE4SS/tree/main/docs/lua-api (`classes/<name>.md`, `global-functions/<name>.md`). Short overview: `unreal.object-model`.

## The object graph: UObject and GUObjectArray

Every reflected object is a `UObject` (or derived: `AActor`, `UClass`, `UFunction`, `UWorld`). Unreal keeps one global chunked array of every live `UObject`, `GUObjectArray`. `ForEachUObject(callback)` walks it, passing `(Object, ChunkIndex, ObjectIndex)`; every finder (`FindFirstOf`, `FindAllOf`, `FindObject`) is built on it.

UE4SS has two wrapper kinds:

- **`RemoteObject`**: a pointer to a game-owned C++ object (what `UObject` inherits from). `IsValid()` reflects whether it is still live.
- **`LocalObject`**: an inlined C++ object owned by Lua (`FName`, `UScriptStruct` proxies, `FText`). `IsValid()` is always `true` "for historic compatibility reasons".

A `RemoteObject` handle can go stale when the game object is destroyed or collected, so check `:IsValid()` before use, especially across frames or in mod state.

Key `UObject` methods: `GetFName()`, `GetClass()`, `GetOuter()`, `GetFullName()` (`ClassName Path.To.Object`, good for debug prints), `GetAddress()`, `IsA(UClass | string)`, `IsAnyClass()`/`IsClass()` (the object is itself a `UClass`), `HasAllFlags`/`HasAnyFlags`/`HasAnyInternalFlags`, `CallFunction(UFunction, ...)`, `Reflection()` (a `UObjectReflection` for metadata-only lookup) and `GetPropertyValue(name)`/`SetPropertyValue(name, value)`. The `__index`/`__newindex` metamethods make `Object.Prop` and `Object.Prop = v` read and write a reflected property, or look up a `UFunction` member.

## UClass, UStruct, UScriptStruct

The reflection hierarchy is itself made of `UObject`s, so `GetClass():GetClass()` makes sense.

- **`UStruct`** (inherits `UObject`): the base type description. `GetSuperStruct()` gives the parent; `ForEachFunction(cb)` and `ForEachProperty(cb)` enumerate members and either callback may `return true` to stop early.
- **`UClass`** (inherits `UStruct`): a class whose instances live in `GUObjectArray`. Adds `GetCDO()` (the ClassDefaultObject, the template new instances copy defaults from, useful to read a default without a live instance) and `IsChildOf(UClass)`.
- **`UScriptStruct`** (inherits `LocalObject`, not `UStruct`): a value type (`FVector`, a Blueprint struct) embedded in another object or property, not a standalone array entry. Reach it through a `StructProperty:GetStruct()` or `FindFirstOf` on the struct's short name; read and write members like a `UObject`. `IsValid()` is always true, so check `IsMappedToObject()` / `IsMappedToProperty()` for whether the memory mapping is live.

Class versus struct: do instances live independently in `GUObjectArray` (class) or as a value embedded in something else (struct). Only `UClass`/`UStruct` expose `ForEachFunction`, `ForEachProperty` and `GetSuperStruct()` directly.

## UFunction

Native and Blueprint functions are both `UFunction`s (inherits `UStruct`). `UFunction.__call` calls it directly (`SomeUFunction(args...)`; if obtained without an owning object, e.g. via `StaticFindObject`, pass a `UObject` context first). `UObject:CallFunction(UFunction, ...)` is the object-scoped equivalent. `GetFunctionFlags()` / `SetFunctionFlags(integer)` read and mutate the `EFunctionFlags` bitmask. UFunctions also appear as members through `__index`: `Character:CanJump()` resolves and calls `CanJump`.

## FName

`FName` (a `LocalObject`) is Unreal's interned string. Names are indices (`ComparisonIndex`) into a global pool, so equality is an integer compare. `GetComparisonIndex()` returns the index, `ToString()` materializes the string. "All FNames returned by `__index` are returned by reference", so do not assume validity past object destruction. Interning is why so many lookups take short names as strings (`FindFirstOf("Character")`, `NotifyOnNewObject("/Script/Engine.Actor", ...)`).

## The property system

Members are also `Property` objects (inherits `RemoteObject`), one per reflected field. `UStruct:ForEachProperty` enumerates them; `UObject:Reflection():GetProperty(name)` returns one by name as metadata without reading the live value. `Property` methods: `GetFName()`, `GetFullName()`, `GetClass()` (the concrete kind, `BoolProperty`, `ObjectProperty`, ...), `IsA(PropertyTypes)`, `ContainerPtrToValuePtr(container, arrayIndex)` and `ImportText(buffer, data, portFlags, ownerObject)`.

Most mods never touch `Property` for simple reads and writes; `__index`/`__newindex` does lookup and marshalling. Use `Property` to introspect a field's type or iterate fields generically. Typed subclasses:

| Kind | Accessor | Gives |
|---|---|---|
| `BoolProperty` | `GetByteOffset()`, `GetByteMask()`, `GetFieldMask()`, `GetFieldSize()` | exact bit in a packed byte (Unreal packs several bools per byte) |
| `ObjectProperty` | `GetPropertyClass()` | the `UClass` the referenced object must be an instance of |
| `StructProperty` | `GetStruct()` | the `UScriptStruct` of the embedded value |
| `ArrayProperty` | `GetInner()` | the element `Property`, which may itself be a struct or object property |

An array of structs is an `ArrayProperty` whose `GetInner()` is a `StructProperty` whose `GetStruct()` is the `UScriptStruct` to enumerate; always resolve through `GetInner()`.

Other kinds: `DelegateProperty`, `MulticastDelegateProperty`, `MulticastSparseDelegateProperty`; check `classes/` for the exact name before assuming one exists. Delegate values are plain Lua tables read and written on the owning object. Map and set fields surface as `TMap`/`TSet` handles (`RemoteObject`-derived: `Find`, `Add`, `Contains`, `Remove`, `Empty`, `ForEach`, `#` for length), not a documented `MapProperty`/`SetProperty`.

**`UEnum`** (inherits `RemoteObject`) describes an enum: `GetNameByValue(value)`, `GetEnumNameByIndex(index)`, `ForEachName(cb)`. Editing methods (`InsertIntoNames`, `EditNameAt`, `EditValueAt`, `RemoveFromNamesAt`) can add or rewrite entries at runtime, rarely needed. Enum values are never bare literals in writes (`unreal.mined-gotchas` G31).

## Finding objects

You almost never walk `GUObjectArray` by hand. The finders (`FindFirstOf`, `FindAllOf`, `FindObject`, `FindObjects`, `StaticFindObject`, `ForEachUObject`, `NotifyOnNewObject`) and their traps (all loaded worlds, whole-array cost) are in `unreal.ue4ss.lua.hooking`. `FindFirstOf` and `FindAllOf` cannot find a `UClass` or a CDO; use `StaticFindObject("/Script/Engine.Character")`.

## Walking the model

```lua
local Character = FindFirstOf("Character")
if Character and Character:IsValid() then
    local Class = Character:GetClass()            -- UClass
    local Level = Class
    while Level do                                 -- walk up toward the root
        print(Level:GetFName():ToString())
        Level = Level:GetSuperStruct()             -- may be invalid at the top; check IsValid()
    end

    Class:ForEachProperty(function(Prop)
        print(string.format("%s : %s", Prop:GetFName():ToString(), tostring(Prop:GetClass())))
    end)
    Class:ForEachFunction(function(Func) print(Func:GetFName():ToString()) end)

    local Prop = Character:Reflection():GetProperty("Health")   -- metadata only
    if Prop then print(Prop:GetFullName()) end

    local Health = Character.Health               -- __index: reflected read
    Character.Health = 100                        -- __newindex: reflected write
    local CanJump = Character:CanJump()           -- __index finds the UFunction, __call invokes it
    local Vec = Character.RelativeLocation        -- UScriptStruct handle (live view, see below)
    Vec.X = 100.0
end
```

Struct copy semantics: a struct read as a property is a live wrapper into the object; a struct returned by a UFunction is a copy (`unreal.field-notes` 12). Nested writes may land on a copy (G26).

Delegate and container access:

```lua
local delegate = PlayerPawn.OnSomeDelegate
if delegate then print(delegate.Object:GetFullName(), tostring(delegate.FunctionName)) end
PlayerPawn.OnSomeDelegate = { Object = SomeObject, FunctionName = FName("MyCallback") }

SomeObject.SomeMap:ForEach(function(key, value)
    -- RemoteUnrealParam (or LocalUnrealParam for value) wrappers; use :get()
    print(tostring(key:get()), tostring(value:get()))
end)
```

Walk containers with the guarded `ForEach` and `:get()` helper (`unreal.field-notes` 25).

## Construction instead of polling, and the last resort

To run code as soon as an instance exists, use `NotifyOnNewObject(fullClassName, callback)` rather than polling `FindFirstOf`: it fires when `StaticConstructObject_Internal` builds a matching instance (inheritance-aware) and the callback can `return true` to unregister. Register each class once per mod; do not stack calls for the same class (the docs' own "What NOT to do"). `ForEachUObject` visits every object in memory, so it is slow; use it only when a finder cannot express the query (for example a condition other than "is an instance of class X").
