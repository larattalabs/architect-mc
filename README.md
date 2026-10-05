# Architect

**Design Minecraft buildings with Claude.** Describe a building or mark a plot in your world, review the
design as a ghost, then place it, keep it in your library, or build it in survival by feeding a
construction site materials.

*Powered by Claude* · Fabric · Minecraft 26.3 · singleplayer

> Early development. See [docs/PLAN.md](docs/PLAN.md) for the plan and decisions.

## Auth

Architect calls Claude through a small local helper (the sidecar). Set `ANTHROPIC_API_KEY` (create a key
at [console.anthropic.com](https://console.anthropic.com)); this is the supported setup.

**Personal use only:** `--use-claude-login` runs the designer on your own local `claude` CLI login
instead of an API key. It is off by default. Anthropic does not allow third-party products to offer
claude.ai login to their users, so don't rely on it for anything you distribute.

## Credits

Based on the building designer and placement code from
[AgentCraft](https://github.com/blendi-remade/agentcraft) (MIT).
