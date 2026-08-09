# splify2: Smart Routing & VPN UI for OpenWrt

splify2 is a complete frontend and management layer for OpenWrt that allows your router to intelligently decide what traffic goes through a VPN and what remains direct. By simply selecting services (e.g., YouTube, Telegram, Discord), you can route them seamlessly for all devices in your home network—without requiring VPN clients on individual phones or PCs, and without slowing down your regular internet traffic.

[![Telegram](https://img.shields.io/badge/Telegram-chat-2CA5E0?style=flat&logo=telegram)](https://t.me/ssplify)
[![Support Project](https://img.shields.io/badge/Support-project-f5365c?style=flat)](https://www.donationalerts.com/r/yo1nkxxd)

## Key Features

- **Whole-Home Coverage:** Configure once on the router, and it works for all connected devices (phones, TVs, consoles, guests).
- **Selective Routing:** Only selected services are routed through the VPN. Local banking, gaming, and regular browsing remain direct for full speed.
- **High-Precision Domain Routing:** Routes traffic based on exact domain names, not just IP lists. This prevents massive IP blocks (like CDN IPs) from accidentally routing unrelated websites through your VPN.
- **Multi-Tunnel Support:** Route different services through different VPNs (e.g., YouTube via Netherlands, Telegram via a personal WireGuard tunnel). Up to three distinct destinations are supported.
- **Failover Capabilities:** Automatically switches to a backup server if the primary VPN fails. If all servers fail, traffic is blocked from leaking into the open internet.
- **Automated Updates:** Categorized lists and services are automatically updated on a schedule from a central repository. No manual list management is required.
- **Universal VPN Compatibility:** Supports direct VLESS/Reality subscription links, standalone `vless://` links, or existing WireGuard/AmneziaWG interfaces.

## System Requirements

- A router running **OpenWrt 24.10 or newer** (requires the `apk` package manager).
- At least **1 MB** of free storage space.
- One of the following:
  - A VLESS/Reality subscription link.
  - A standalone `vless://` link.
  - A pre-configured WireGuard or AmneziaWG interface.

## Installation

Run the following command on your router to install splify2 automatically:

```sh
sh -c "$(wget -qO- https://raw.githubusercontent.com/xyzmean/splify2/main/install.sh)"
```

The script will detect your router's architecture, install the core routing engine (`steer`), set up the web interface, and enable the service. 

Once installed, navigate to **LuCI → Services → splify2** in your router's web interface to complete the setup.

## Architecture & Responsibilities

splify2 acts as the control plane and user interface, but the actual packet routing is handled by the high-performance **[steer](https://github.com/xyzmean/steer)** engine.

- **splify2 (This Project):** Manages lists, UI, user preferences, and updates. It translates your choices into a configuration file for `steer`.
- **steer:** A lightweight C engine that compiles the configuration into `nftables` rules, `fake-ip` DNS sets, and handles VLESS/Reality tunnels directly.

If the `steer` engine is not installed, the splify2 interface will prompt you to install it. You can choose between:
- **Extended:** Includes built-in VLESS/Reality tunneling (recommended if you use subscription links).
- **Base:** Only routing. Use this if you rely purely on existing WireGuard tunnels.

### Data Sources
- Routing lists (IPs and Domains): [xyzmean/ru-bypass-ipsets](https://github.com/xyzmean/ru-bypass-ipsets)
- Base domain lists: [itdoginfo/allow-domains](https://github.com/itdoginfo/allow-domains)
- Core routing engine: [xyzmean/steer](https://github.com/xyzmean/steer)

## Documentation

- [rpcd-api.md](docs/rpcd-api.md): Contract for the `splify2` ubus/rpcd object — every method's input (JSON on stdin) and output, the error object shape, and the ACL grouping.

## Development & Building

The UI is built using React and Tailwind CSS, styled to match the OpenWrt Argon theme.

```sh
cd ui 
npm install 
npm run build
cd ..
./build.sh                 # Builds the luci-app-splify2 package (requires Docker)
```

The resulting package is architecture-independent, as all binary components are contained within the `steer` engine. Releases are managed automatically via GitHub Actions.
