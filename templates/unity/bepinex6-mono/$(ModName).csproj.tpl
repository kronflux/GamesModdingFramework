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
    <Reference Include="BepInEx.Core">
      <HintPath>$(LoaderDir)/core/BepInEx.Core.dll</HintPath>
      <Private>false</Private>
    </Reference>
    <Reference Include="BepInEx.Unity.Mono">
      <HintPath>$(LoaderDir)/core/BepInEx.Unity.Mono.dll</HintPath>
      <Private>false</Private>
    </Reference>
    <Reference Include="UnityEngine.CoreModule">
      <HintPath>$(ManagedDir)/UnityEngine.CoreModule.dll</HintPath>
      <Private>false</Private>
    </Reference>
  </ItemGroup>
</Project>
