# Third-party software

Pako is MIT-licensed (see LICENSE). The control panel serves these libraries from `node_modules`, unchanged, and the server depends on the packages in
`package.json`. Their own licenses apply to them:

| Library | License |
| --- | --- |
| [Three.js](https://threejs.org) (the orb) | MIT |
| [Lucide](https://lucide.dev) (icons) | ISC |
| [Inter](https://rsms.me/inter/) via `@fontsource-variable/inter` (the font) | SIL Open Font License 1.1 |
| [GSAP](https://gsap.com) (motion in the panel) | GreenSock "Standard no charge" license: free to use, **not an open-source license**. Its terms apply to anyone who redistributes a bundle containing it; read them at https://gsap.com/standard-license, or remove it (the panel degrades to no motion) |
| Express, express-rate-limit, zod, the MCP SDK | MIT |

The phone voice (`voice-worker/`) depends on the LiveKit Agents SDK (Apache-2.0) and Google's GenAI SDK (Apache-2.0); some of their optional native packages carry LGPL licenses.
