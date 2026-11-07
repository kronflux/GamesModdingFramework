---
name: unreal.object-model
title: Unreal object model and reflection
description: Navigate UObject, UClass, UFunction and FName through the reflection system instead of guessing memory layout.
engine: unreal
tags: [object-model, uobject, reflection, uclass, fname]
confidence: verified
sources: [Unreal Engine reflection documentation, UE4SS object dump format notes, earlier Unreal modding framework notes]
---

# Unreal object model and reflection

The full class, property and Lua walkthrough is in `unreal.reflection`.

Unreal exposes a reflection system that names every live object, class, function
and property.

## Core types

- `UObject` is the base of every reflected object.
- `UClass` describes a class. It holds the property chain, function table and
  class flags.
- `UFunction` describes a reflected function with its parameter layout.
- `FName` is an interned name. Comparing names is cheaper than comparing strings.
- `UWorld`, `UGameInstance`, `APlayerController` and `AGameModeBase` are common
  entry points.

## Finding objects

- A dump lists objects with their full paths, for example
  `/Game/Blueprints/BP_Player.BP_Player_C`.
- `StaticFindObject` resolves a path at runtime.
- `FindAllOf("ClassName")` returns every live instance of a class.
- `GObjects` or the global object array gives low-level access when a name is
  not enough.

## Properties

A reflected property has an offset in the class layout. Read it through the
reflection API when one exists. A hard-coded offset changes with the game build
and sometimes with a hotfix.

## Pitfalls

- An object path that ends in `_C` is a class default object, not a live
  instance.
- A blueprint function can be a `UFunction` even when no C++ symbol exists.
- Names are case-insensitive at lookup time but dumps preserve case. Use the
  dump spelling when you record evidence.
