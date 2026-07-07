# Feature Comparison: Our AI-CCTV Dashboard vs. Milestone XProtect

This document compares our project with **Milestone XProtect**, one of the biggest enterprise video management systems (VMS) in the world. The goal is to show, in plain language, what each system does well and where the gaps are.

## At a glance

| | **Our Project** | **Milestone XProtect** |
|---|---|---|
| **What it is** | AI-first live dashboard | Enterprise recording + management VMS |
| **Best at** | Real-time face / fire / person detection | Long-term recording, evidence, scale |
| **Scale** | One server, a handful of cameras | Thousands of cameras, many sites |
| **Cost** | Free, open-source | Paid, per-camera licensing |
| **Setup** | Run `start.bat`, done | Enterprise deployment + training |

---

## What both systems can do

These are features where both products cover the same ground (even if the depth differs).

| Feature | Our Project | XProtect |
|---|:---:|:---:|
| View multiple cameras live in one screen | Yes (HLS in browser) | Yes (Smart Client) |
| Connect to RTSP IP cameras | Yes (via MediaMTX) | Yes |
| Detect people in the frame | Yes (YOLOv8) | Yes (via add-ons) |
| Recognize known faces by name | Yes (FaceNet, built-in) | Yes (via BriefCam add-on) |
| Detect fire and smoke | Yes (built-in) | Yes (via add-ons) |
| Save alert snapshots | Yes (auto-burned boxes) | Yes (Evidence Lock) |
| Log incidents to a database | Yes (MySQL) | Yes |
| Show cameras on a map | Yes (Leaflet) | Yes (Smart Map) |
| Multiple users with logins | Yes (JWT) | Yes |
| Per-user data separation | Yes | Yes (via roles) |
| Charts and analytics | Yes (heatmaps, breakdowns) | Yes (Centralized Search) |
| Health monitoring | Basic (`/system-health`) | Yes (Milestone Care) |

---

## What XProtect has that we don't

These are the features we'd need to add to compete in the enterprise space.

### Recording and storage
- **Continuous 24/7 recording** — we only save snapshots when something triggers
- **Retention policies** — automatic deletion of old footage by age or disk usage
- **Failover recording** — backup recorder takes over if the main one fails
- **Hot/cold storage tiers** — move old recordings to slower, cheaper disks

### Scale and deployment
- **Multi-site federation** — connect dozens of buildings into one view (XProtect Interconnect)
- **Cloud and hybrid hosting** — runs on AWS, Azure, Google Cloud
- **Dedicated hardware appliances** — Husky servers pre-tuned for the software
- **Mobile gateway in DMZ** — secure remote access architecture

### Security and evidence
- **AES-256 encryption** of recorded video at rest
- **SHA-2 digital signing** so exported clips can be proven untampered
- **Evidence Lock** to prevent accidental or deliberate deletion
- **Chain-of-custody documentation** for use in court
- **Single sign-on (SSO)** with OAuth2 / OpenID Connect / Active Directory
- **Role-based permissions** with granular per-camera, per-feature controls

### Client apps and viewing
- **Native desktop client** (Smart Client) with hardware acceleration
- **Native mobile apps** for iOS and Android
- **Video wall** support for control rooms
- **Time-synchronized playback** across many cameras at once
- **Audio support** — two-way audio, recording, playback

### Analytics and integrations
- **License Plate Recognition (LPR)** built-in
- **1,000+ third-party integrations** (access control, intercoms, sensors)
- **Open SDK and APIs** for custom apps
- **Access control integration** (door entry, intercoms)

### Enterprise operations
- **24/7 support contracts** with guaranteed response times
- **Centralized management** of cameras across all sites

---

## What we have that XProtect doesn't (out of the box)

These are real wins for our project — XProtect usually needs paid add-ons for these.

| Feature | Why it matters |
|---|---|
| **Built-in face recognition (FaceNet)** | No paid add-on, no separate analytics server. Just upload photos and it works. |
| **Hot-reload of enrolled faces** | Add a new face, the AI picks it up within seconds — no restart |
| **Built-in fire/smoke detection** | Custom YOLO model with a smart HSV fallback when no model is installed |
| **Per-person categorization** | Tag people as `standard / staff / vip / visitor / threat` with notes |
| **Movement-path drill-down** | Click a recognized person → see their path across cameras on a map |
| **Per-user feature toggles** | Each user picks which detections to log (face / person / fire) |
| **Auto-throttled incident snapshots** | Smart per-type throttling so fires don't get drowned out by face matches |
| **Single-command startup** | `start.bat` launches the whole stack |
| **No licensing fees** | Open source, runs on any modest Windows or Linux box |

---

## When to use which

**Pick our project if you want:**
- A working AI dashboard today, free of charge
- Real-time face and fire alerts as the main feature
- A small site with under ~20 cameras
- Full control over the code and data

**Pick XProtect if you need:**
- 24/7 recorded video for weeks or months
- Many sites or many hundreds of cameras
- Court-admissible evidence with chain of custody
- Enterprise SSO, audit logs, support contracts
- A mobile app for guards on the go

---

## Honest summary

XProtect is a **recording-first** platform that the industry has built on for 20+ years. It records everything, then lets you search and analyze later. Analytics like face recognition are bolted on through paid partners.

Our project is the opposite — **analytics-first**. It watches cameras live, reacts to events instantly, and only saves what matters. There's no archive, no federation, no signed evidence pipeline. But the AI features that XProtect charges extra for are built right in and free to run.

For a small business, school, or single building that wants smart alerts without paying for an enterprise VMS, our project covers the day-to-day needs. For anything with legal, multi-site, or 24/7 recording requirements, XProtect is the safer choice.
