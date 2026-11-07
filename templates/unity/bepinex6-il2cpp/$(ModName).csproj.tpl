<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>$(TargetFramework)</TargetFramework>
    <AssemblyName>$(ModName)</AssemblyName>
    <RootNamespace>$(ModName)</RootNamespace>
    <Version>$(Version)</Version>
    <Authors>$(Author)</Authors>
    <LangVersion>latest</LangVersion>
    <Nullable>disable</Nullable>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
  </PropertyGroup>

  <ItemGroup>
    <Reference Include="0Harmony">
      <HintPath>$(LoaderDir)/core/0Harmony.dll</HintPath>
      <Private>false</Private>
    </Reference>
    <Reference Include="Il2CppInterop.Runtime">
      <HintPath>$(LoaderDir)/core/Il2CppInterop.Runtime.dll</HintPath>
      <Private>false</Private>
    </Reference>
    <Reference Include="BepInEx.Core">
      <HintPath>$(LoaderDir)/core/BepInEx.Core.dll</HintPath>
      <Private>false</Private>
    </Reference>
    <Reference Include="BepInEx.Unity.IL2CPP">
      <HintPath>$(LoaderDir)/core/BepInEx.Unity.IL2CPP.dll</HintPath>
      <Private>false</Private>
    </Reference>
  </ItemGroup>
  <!-- Every interop assembly: game types (for example the game's own assembly)
       derive from types in other interop assemblies (Mirror, UnityEngine.*),
       and the compiler needs all of them. -->
  <ItemGroup>
    <Reference Include="$(InteropDir)/*.dll" Private="false" />
  </ItemGroup>
</Project>
