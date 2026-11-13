#include "GmfCommon.hpp"

#include <charconv>

#include <Unreal/UObjectArray.hpp>
#include <cmath>

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>

namespace GmfDumper
{
    auto MemoryChecker::is_readable(const void* address, size_t size) -> bool
    {
        auto begin = reinterpret_cast<uint64_t>(address);
        if (begin == 0)
        {
            return false;
        }
        uint64_t end = begin + (size == 0 ? 1 : size);
        uint64_t current = begin;
        while (current < end)
        {
            const Region* region = query(current);
            if (!region || !region->readable)
            {
                return false;
            }
            current = region->end;
        }
        return true;
    }

    auto MemoryChecker::query(uint64_t address) -> const Region*
    {
        auto it = m_regions.upper_bound(address);
        if (it != m_regions.begin())
        {
            auto& candidate = std::prev(it)->second;
            if (address >= candidate.base && address < candidate.end)
            {
                return &candidate;
            }
        }

        MEMORY_BASIC_INFORMATION info{};
        if (VirtualQuery(reinterpret_cast<LPCVOID>(address), &info, sizeof(info)) == 0)
        {
            return nullptr;
        }
        Region region{};
        region.base = reinterpret_cast<uint64_t>(info.BaseAddress);
        region.end = region.base + info.RegionSize;
        if (info.State == MEM_COMMIT && !(info.Protect & (PAGE_NOACCESS | PAGE_GUARD)))
        {
            region.readable = (info.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READ |
                                               PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)) != 0;
        }
        auto [inserted, _] = m_regions.insert_or_assign(region.base, region);
        return &inserted->second;
    }

    auto is_live_object(MemoryChecker& memory, UObject* object) -> bool
    {
        if (!object || (reinterpret_cast<uintptr_t>(object) & 0x7) != 0)
        {
            return false;
        }
        if (!memory.is_readable(object, 0x30))
        {
            return false;
        }
        if (*reinterpret_cast<uint64_t*>(object) == 0)
        {
            return false;
        }
        int32_t index = object->GetInternalIndex();
        if (index < 0 || index >= FUObjectArray::GetNumElements())
        {
            return false;
        }
        FUObjectItem* item = FUObjectArray::IndexToObject(index);
        return item && item->GetUObject() == object && object->GetClassPrivate() != nullptr;
    }

    auto json_escape(std::string_view text) -> std::string
    {
        std::string out{};
        out.reserve(text.size() + 2);
        for (unsigned char c : text)
        {
            switch (c)
            {
            case '"':
                out.append("\\\"");
                break;
            case '\\':
                out.append("\\\\");
                break;
            case '\n':
                out.append("\\n");
                break;
            case '\r':
                out.append("\\r");
                break;
            case '\t':
                out.append("\\t");
                break;
            default:
                if (c < 0x20)
                {
                    char escaped[8];
                    std::snprintf(escaped, sizeof(escaped), "\\u%04x", c);
                    out.append(escaped);
                }
                else
                {
                    out.push_back(static_cast<char>(c));
                }
            }
        }
        return out;
    }

    auto base64_encode(const uint8_t* data, size_t size) -> std::string
    {
        static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        std::string out{};
        out.reserve(((size + 2) / 3) * 4);
        size_t i = 0;
        for (; i + 3 <= size; i += 3)
        {
            uint32_t n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
            out.push_back(alphabet[(n >> 18) & 63]);
            out.push_back(alphabet[(n >> 12) & 63]);
            out.push_back(alphabet[(n >> 6) & 63]);
            out.push_back(alphabet[n & 63]);
        }
        if (i + 1 == size)
        {
            uint32_t n = data[i] << 16;
            out.push_back(alphabet[(n >> 18) & 63]);
            out.push_back(alphabet[(n >> 12) & 63]);
            out.append("==");
        }
        else if (i + 2 == size)
        {
            uint32_t n = (data[i] << 16) | (data[i + 1] << 8);
            out.push_back(alphabet[(n >> 18) & 63]);
            out.push_back(alphabet[(n >> 12) & 63]);
            out.push_back(alphabet[(n >> 6) & 63]);
            out.push_back('=');
        }
        return out;
    }

    auto open_text_file(const std::filesystem::path& path) -> std::ofstream
    {
        std::ofstream out{path, std::ios::binary | std::ios::trunc};
        if (!out)
        {
            throw std::runtime_error{"could not open for writing: " + path_to_utf8(path)};
        }
        return out;
    }

    JsonWriter::JsonWriter(const std::filesystem::path& path) : m_path(path)
    {
        m_out = open_text_file(path);
        m_buffer.reserve(1 << 20);
    }

    JsonWriter::JsonWriter(Discard) : m_closed(true), m_discard(true)
    {
    }

    auto JsonWriter::reset() -> void
    {
        m_levels.clear();
        m_buffer.clear();
        m_after_key = false;
    }

    JsonWriter::~JsonWriter()
    {
        if (!m_closed)
        {
            // Destructors must not throw; a failed write here is reported by close() in the
            // normal path and lost only while another error is already unwinding.
            try
            {
                close();
            }
            catch (...)
            {
            }
        }
    }

    auto JsonWriter::write(std::string_view text) -> void
    {
        if (m_discard)
        {
            m_buffer.clear();
            return;
        }
        m_buffer.append(text);
        if (!m_buffer.empty())
        {
            m_last = m_buffer.back();
        }
        if (m_buffer.size() >= (1 << 20))
        {
            m_out.write(m_buffer.data(), static_cast<std::streamsize>(m_buffer.size()));
            m_buffer.clear();
        }
    }

    auto JsonWriter::write_escaped(std::string_view text) -> void
    {
        m_buffer.push_back('"');
        for (unsigned char c : text)
        {
            switch (c)
            {
            case '"':
                m_buffer.append("\\\"");
                break;
            case '\\':
                m_buffer.append("\\\\");
                break;
            case '\n':
                m_buffer.append("\\n");
                break;
            case '\r':
                m_buffer.append("\\r");
                break;
            case '\t':
                m_buffer.append("\\t");
                break;
            default:
                if (c < 0x20)
                {
                    char escaped[8];
                    std::snprintf(escaped, sizeof(escaped), "\\u%04x", c);
                    m_buffer.append(escaped);
                }
                else
                {
                    m_buffer.push_back(static_cast<char>(c));
                }
            }
        }
        m_buffer.push_back('"');
        write({});
    }

    auto JsonWriter::before_value() -> void
    {
        if (m_discard)
        {
            return;
        }
        if (m_after_key)
        {
            m_after_key = false;
            return;
        }
        if (m_levels.empty())
        {
            return;
        }
        auto& level = m_levels.back();
        if (level.has_items)
        {
            write(",");
        }
        if (level.one_per_line)
        {
            write("\n");
        }
        level.has_items = true;
    }

    auto JsonWriter::begin_object() -> void
    {
        if (m_discard)
        {
            return;
        }
        before_value();
        write("{");
        m_levels.push_back({false, false, false});
    }

    auto JsonWriter::end_object() -> void
    {
        if (m_discard)
        {
            return;
        }
        m_levels.pop_back();
        write("}");
    }

    auto JsonWriter::begin_array(bool one_per_line) -> void
    {
        if (m_discard)
        {
            return;
        }
        before_value();
        write("[");
        m_levels.push_back({true, one_per_line, false});
    }

    auto JsonWriter::end_array() -> void
    {
        if (m_discard)
        {
            return;
        }
        auto level = m_levels.back();
        m_levels.pop_back();
        if (level.one_per_line && level.has_items)
        {
            write("\n");
        }
        write("]");
    }

    auto JsonWriter::key(std::string_view name) -> void
    {
        if (m_discard)
        {
            return;
        }
        auto& level = m_levels.back();
        if (level.has_items)
        {
            write(",");
        }
        level.has_items = true;
        write_escaped(name);
        write(":");
        m_after_key = true;
    }

    auto JsonWriter::value(std::string_view text) -> void
    {
        if (m_discard)
        {
            return;
        }
        before_value();
        write_escaped(text);
    }

    auto JsonWriter::value(int64_t number) -> void
    {
        if (m_discard)
        {
            return;
        }
        before_value();
        char buffer[32];
        auto result = std::to_chars(buffer, buffer + sizeof(buffer), number);
        write(std::string_view{buffer, static_cast<size_t>(result.ptr - buffer)});
    }

    auto JsonWriter::value(uint64_t number) -> void
    {
        if (m_discard)
        {
            return;
        }
        before_value();
        char buffer[32];
        auto result = std::to_chars(buffer, buffer + sizeof(buffer), number);
        write(std::string_view{buffer, static_cast<size_t>(result.ptr - buffer)});
    }

    auto JsonWriter::value(double number) -> void
    {
        if (m_discard)
        {
            return;
        }
        before_value();
        if (!std::isfinite(number))
        {
            // JSON has no NaN or infinity.
            write("null");
            return;
        }
        char buffer[64];
        auto result = std::to_chars(buffer, buffer + sizeof(buffer), number);
        write(std::string_view{buffer, static_cast<size_t>(result.ptr - buffer)});
    }

    auto JsonWriter::value(bool flag) -> void
    {
        if (m_discard)
        {
            return;
        }
        before_value();
        write(flag ? "true" : "false");
    }

    auto JsonWriter::null() -> void
    {
        if (m_discard)
        {
            return;
        }
        before_value();
        write("null");
    }

    auto JsonWriter::line_break() -> void
    {
        if (m_discard)
        {
            return;
        }
        m_buffer.push_back(char(10));
        m_last = char(10);
    }

    auto JsonWriter::value(float number) -> void
    {
        if (m_discard)
        {
            return;
        }
        before_value();
        if (!std::isfinite(number))
        {
            write("null");
            return;
        }
        char buffer[64];
        auto result = std::to_chars(buffer, buffer + sizeof(buffer), number);
        write(std::string_view{buffer, static_cast<size_t>(result.ptr - buffer)});
    }

    auto JsonWriter::close() -> void
    {
        if (m_closed)
        {
            return;
        }
        m_closed = true;
        if (m_last != char(10))
        {
            m_buffer.push_back(char(10));
        }
        m_out.write(m_buffer.data(), static_cast<std::streamsize>(m_buffer.size()));
        m_buffer.clear();
        m_out.flush();
        bool failed = !m_out;
        m_out.close();
        if (failed)
        {
            throw std::runtime_error{"write failed: " + path_to_utf8(m_path)};
        }
    }
} // namespace GmfDumper
