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

  <!-- MelonLoader 0.7: MelonLoader/net6 for IL2CPP, MelonLoader/net472 or net35 for Mono. -->
  <ItemGroup>
    <Reference Include="MelonLoader">
      <HintPath>$(LoaderDir)/MelonLoader.dll</HintPath>
      <Private>false</Private>
    </Reference>
    <Reference Include="0Harmony">
      <HintPath>$(LoaderDir)/0Harmony.dll</HintPath>
      <Private>false</Private>
    </Reference>
  </ItemGroup>

  <!-- Mono: the game's own managed assemblies. -->
  <ItemGroup Condition="'$(InteropDir)' == ''">
    <Reference Include="UnityEngine.CoreModule">
      <HintPath>$(ManagedDir)/UnityEngine.CoreModule.dll</HintPath>
      <Private>false</Private>
    </Reference>
  </ItemGroup>

  <!-- IL2CPP: Il2CppInterop and every generated interop assembly, so game types
       and their base types (networking libraries, for example) resolve. They exist
       after the game has been launched once with MelonLoader. -->
  <ItemGroup Condition="'$(InteropDir)' != ''">
    <Reference Include="Il2CppInterop.Runtime">
      <HintPath>$(LoaderDir)/Il2CppInterop.Runtime.dll</HintPath>
      <Private>false</Private>
    </Reference>
    <Reference Include="$(InteropDir)/*.dll" Private="false" />
  </ItemGroup>
</Project>
