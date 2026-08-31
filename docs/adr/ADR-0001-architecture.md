# ADR-0001: Three-Component Architecture

Status: accepted.

Use a thin in-TUI plugin, one node per machine, and one hub per Telegram bot. This isolates volatile OpenCode APIs, avoids bot poller conflicts, and permits outbound-only machines without putting Telegram credentials in OpenCode.
