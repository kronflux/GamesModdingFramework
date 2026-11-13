#include "GmfCommon.hpp"
#include "Dumpers.hpp"

#include <algorithm>
#include <system_error>

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>

namespace GmfDumper
{
    namespace fs = std::filesystem;

    static auto fail(const char* action, const fs::path& path, const std::error_code& ec) -> void
    {
        throw std::runtime_error{std::string{action} + " '" + path_to_utf8(path) + "': " + ec.message()};
    }

    auto fs_make_dirs(const fs::path& path) -> void
    {
        std::error_code ec{};
        fs::create_directories(path, ec);
        if (ec && !fs::is_directory(path))
        {
            fail("could not create folder", path, ec);
        }
    }

    auto fs_move(const fs::path& from, const fs::path& to) -> void
    {
        std::error_code ec{};
        if (!fs::exists(from, ec))
        {
            throw std::runtime_error{"cannot move, source does not exist: " + path_to_utf8(from)};
        }
        if (to.has_parent_path())
        {
            fs::create_directories(to.parent_path(), ec);
        }

        // rename replaces an existing file, and moves a whole folder when the target does
        // not exist. It fails across volumes; copy and delete covers that case.
        ec.clear();
        fs::rename(from, to, ec);
        if (!ec)
        {
            return;
        }

        std::error_code copy_ec{};
        fs::copy(from, to, fs::copy_options::recursive | fs::copy_options::overwrite_existing, copy_ec);
        if (copy_ec)
        {
            fail("could not move", from, ec);
        }
        fs::remove_all(from, copy_ec);
    }

    auto fs_list_dir(const fs::path& path) -> std::string
    {
        std::vector<std::string> names{};
        std::error_code ec{};
        for (fs::directory_iterator it{path, ec}, end{}; !ec && it != end; it.increment(ec))
        {
            names.push_back(path_to_utf8(it->path().filename()));
        }
        std::sort(names.begin(), names.end());
        std::string out{};
        for (const auto& name : names)
        {
            out.append(name);
            out.push_back('\n');
        }
        return out;
    }

    auto fs_file_size(const fs::path& path) -> int64_t
    {
        std::error_code ec{};
        if (!fs::is_regular_file(path, ec))
        {
            return -1;
        }
        auto size = fs::file_size(path, ec);
        return ec ? -1 : static_cast<int64_t>(size);
    }

    auto fs_is_dir(const fs::path& path) -> bool
    {
        std::error_code ec{};
        return fs::is_directory(path, ec);
    }

    auto end_process() -> void
    {
        // TerminateProcess skips exit handlers and static destructors. Running those from
        // inside a game-thread callback, while the engine's other threads are alive, can
        // hang or fault; by the time this is called every dump file is closed.
        TerminateProcess(GetCurrentProcess(), 0);
    }

    auto game_exe_info() -> std::string
    {
        // Identifies the game build a dump came from: the executable path, its size, and the
        // link time stored in its header.
        wchar_t buffer[32768];
        DWORD length = GetModuleFileNameW(nullptr, buffer, static_cast<DWORD>(std::size(buffer)));
        fs::path exe{std::wstring{buffer, length}};
        std::error_code ec{};
        auto size = fs::file_size(exe, ec);
        uint64_t link_time{};
        if (auto* base = reinterpret_cast<const uint8_t*>(GetModuleHandleW(nullptr)))
        {
            auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
            if (dos->e_magic == IMAGE_DOS_SIGNATURE)
            {
                auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS*>(base + dos->e_lfanew);
                if (nt->Signature == IMAGE_NT_SIGNATURE)
                {
                    link_time = nt->FileHeader.TimeDateStamp;
                }
            }
        }
        return path_to_utf8(exe) + "|" + std::to_string(ec ? 0 : size) + "|" + std::to_string(link_time);
    }

    auto fs_tree_stats(const fs::path& path) -> std::string
    {
        uint64_t bytes{};
        uint64_t count{};
        std::error_code ec{};
        if (fs::is_regular_file(path, ec))
        {
            bytes = fs::file_size(path, ec);
            count = 1;
        }
        else if (fs::is_directory(path, ec))
        {
            for (fs::recursive_directory_iterator it{path, ec}, end{}; !ec && it != end; it.increment(ec))
            {
                std::error_code entry_ec{};
                if (it->is_regular_file(entry_ec))
                {
                    bytes += it->file_size(entry_ec);
                    ++count;
                }
            }
        }
        return std::to_string(bytes) + " " + std::to_string(count);
    }
} // namespace GmfDumper
