/**
 * What the box may run for local inference and fine-tuning (AI01/AI02, docs/architecture-v2/local-ai.md).
 *
 * Everything here is pinned by digest and ships in the endorsed release: the release signature is
 * the trust, nothing is looked up at run time. A model is a GGUF file fetched from an allowlisted
 * registry at a fixed revision and checked against its SHA-256 before the box keeps it; the server
 * that loads it is llama.cpp's own image at one build, by manifest-list digest. Parsing a model file
 * is untrusted work: it happens only inside gVisor (or the GPU allocation's runtime), with no network
 * and the models volume read-only. No model code is ever loaded ("trust remote code" never applies:
 * GGUF holds weights and a chat template, nothing executable).
 *
 * The same image references are allowlisted in both privileged brokers (packages/privd/src/policy.ts
 * LOCAL_AI_IMAGES, rust/crates/flagship-broker/src/policy.rs): a change here without them is refused.
 */
import type { Backend } from "../gpu/broker.js";

/** llama.cpp build b11541 (2026-10-10), every image by manifest-list digest. */
export const LLAMA_CPP_BUILD = "b11541";

export const LOCAL_AI_IMAGES = {
  serverCpu: "ghcr.io/ggml-org/llama.cpp:server-b11541@sha256:bf3da52e92c083472b3d1c9f9da081f423ab9def95a87ec4bba51940382d75fd",
  serverCuda: "ghcr.io/ggml-org/llama.cpp:server-cuda-b11541@sha256:f88fa8d94d872312a4ad117acd490fa997bef81f03f161f0cfe0d74272e5b5bb",
  serverRocm: "ghcr.io/ggml-org/llama.cpp:server-rocm-b11541@sha256:353312d6637cad6a1492d5ab1c0373137163a73d6bce98c821ebcb1abfebcf8c",
  serverIntel: "ghcr.io/ggml-org/llama.cpp:server-intel-b11541@sha256:f74b70ab42a1715a093d67372fdc413a8af671b48bb6f8ae02eb0fb92356f94d",
  trainCpu: "ghcr.io/ggml-org/llama.cpp:full-b11541@sha256:bf349ede99cd7d4e2aa476323da02837a554b609ee02d40e363cf98515f4d640",
  trainCuda: "ghcr.io/ggml-org/llama.cpp:full-cuda-b11541@sha256:12055d1d7d97498f7563837bcb21f4eff05cc15d42c5f8b460afcf53982cdf59",
  trainRocm: "ghcr.io/ggml-org/llama.cpp:full-rocm-b11541@sha256:afb1b28de45ab29a1a2e810da620908c0fb4105fdf05b96d4dd692e7db56cc9c",
  trainIntel: "ghcr.io/ggml-org/llama.cpp:full-intel-b11541@sha256:72ed99a5f846170a479c41979439e61a0db4a6949cdda45422115607b8a1973d",
} as const;

export const ALL_LOCAL_AI_IMAGES: readonly string[] = Object.values(LOCAL_AI_IMAGES);

/** The inference server's image for a device (CPU when `backend` is null). */
export function serverImageFor(backend: Backend | null): string {
  switch (backend) {
    case "nvidia-cuda":
      return LOCAL_AI_IMAGES.serverCuda;
    case "amd-rocm":
      return LOCAL_AI_IMAGES.serverRocm;
    case "intel-level-zero":
      return LOCAL_AI_IMAGES.serverIntel;
    default:
      return LOCAL_AI_IMAGES.serverCpu;
  }
}

export function trainImageFor(backend: Backend | null): string {
  switch (backend) {
    case "nvidia-cuda":
      return LOCAL_AI_IMAGES.trainCuda;
    case "amd-rocm":
      return LOCAL_AI_IMAGES.trainRocm;
    case "intel-level-zero":
      return LOCAL_AI_IMAGES.trainIntel;
    default:
      return LOCAL_AI_IMAGES.trainCpu;
  }
}

/**
 * Where model files may come from. A download follows redirects only to these hosts (Hugging Face
 * serves LFS files from its own CDN names), and the bytes are judged by SHA-256 alone.
 */
export const MODEL_REGISTRY_HOSTS: readonly string[] = ["huggingface.co", "*.huggingface.co", "*.hf.co"];

export function registryHostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return MODEL_REGISTRY_HOSTS.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}

export type ModelPurpose = "build" | "chat" | "test";

export interface LocalModel {
  /** Catalog id: what the apps send as `model` for "On this server". */
  id: string;
  name: string;
  /** A short line the model menu shows. */
  descriptor: string;
  parameters: string;
  quantization: string;
  sizeBytes: number;
  /** SHA-256 of the GGUF file, lowercase hex. */
  sha256: string;
  source: { host: "huggingface.co"; repo: string; revision: string; path: string };
  license: { id: string; url: string };
  contextTokens: number;
  /** The context the box runs it with (memory grows with it). */
  serveContextTokens: number;
  /** Answers tool calls through llama.cpp's chat template (`--jinja`): the builder needs it. */
  tools: boolean;
  purpose: ModelPurpose;
  /** F32 weights: llama-finetune can train it on CPU or a GPU. */
  trainable: boolean;
}

const HF = (repo: string, revision: string, path: string) => ({ host: "huggingface.co" as const, repo, revision, path });

/** The pinned catalog. Sizes and digests are Hugging Face's own LFS records at these revisions. */
export const LOCAL_MODELS: readonly LocalModel[] = [
  {
    id: "qwen2.5-coder-7b-q4",
    name: "Qwen2.5 Coder 7B",
    descriptor: "Best for building apps; wants a GPU",
    parameters: "7B",
    quantization: "Q4_K_M",
    sizeBytes: 4_683_073_536,
    sha256: "509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c",
    source: HF("Qwen/Qwen2.5-Coder-7B-Instruct-GGUF", "13fb94bfda8c8cf22497dc57b78f391a9acb426a", "qwen2.5-coder-7b-instruct-q4_k_m.gguf"),
    license: { id: "apache-2.0", url: "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/blob/13fb94bfda8c8cf22497dc57b78f391a9acb426a/LICENSE" },
    contextTokens: 32_768,
    serveContextTokens: 16_384,
    tools: true,
    purpose: "build",
    trainable: false,
  },
  {
    id: "qwen2.5-1.5b-q4",
    name: "Qwen2.5 1.5B",
    descriptor: "Small and quick; fine for app features",
    parameters: "1.5B",
    quantization: "Q4_K_M",
    sizeBytes: 1_117_320_736,
    sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
    source: HF("Qwen/Qwen2.5-1.5B-Instruct-GGUF", "91cad51170dc346986eccefdc2dd33a9da36ead9", "qwen2.5-1.5b-instruct-q4_k_m.gguf"),
    license: { id: "apache-2.0", url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/blob/91cad51170dc346986eccefdc2dd33a9da36ead9/LICENSE" },
    contextTokens: 32_768,
    serveContextTokens: 8_192,
    tools: true,
    purpose: "chat",
    trainable: false,
  },
  {
    id: "qwen2.5-0.5b-q4",
    name: "Qwen2.5 0.5B",
    descriptor: "Tiny; runs on any server",
    parameters: "0.5B",
    quantization: "Q4_K_M",
    sizeBytes: 491_400_032,
    sha256: "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db",
    source: HF("Qwen/Qwen2.5-0.5B-Instruct-GGUF", "9217f5db79a29953eb74d5343926648285ec7e67", "qwen2.5-0.5b-instruct-q4_k_m.gguf"),
    license: { id: "apache-2.0", url: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/blob/9217f5db79a29953eb74d5343926648285ec7e67/LICENSE" },
    contextTokens: 32_768,
    serveContextTokens: 8_192,
    tools: true,
    purpose: "chat",
    trainable: false,
  },
  {
    id: "stories-15m",
    name: "TinyStories 15M",
    descriptor: "A small model to fine-tune on an app's sample text",
    parameters: "15M",
    quantization: "F32",
    sizeBytes: 98_357_920,
    sha256: "61b50d457809a5194818fd22e6724b456cd7bb9a6264c52c8110684c53f3704a",
    source: HF("ggml-org/models-moved", "499bc8821c6b12b4e53c5bffcb21ec206f212d81", "tinyllamas/stories15M.gguf"),
    license: { id: "mit", url: "https://github.com/karpathy/llama2.c/blob/master/LICENSE" },
    contextTokens: 256,
    serveContextTokens: 256,
    tools: false,
    purpose: "test",
    trainable: true,
  },
  {
    id: "stories-260k",
    name: "TinyStories 260K",
    descriptor: "A test model: checks the server works, not for real use",
    parameters: "260K",
    quantization: "F32",
    sizeBytes: 1_185_376,
    sha256: "270cba1bd5109f42d03350f60406024560464db173c0e387d91f0426d3bd256d",
    source: HF("ggml-org/models-moved", "499bc8821c6b12b4e53c5bffcb21ec206f212d81", "tinyllamas/stories260K.gguf"),
    license: { id: "mit", url: "https://github.com/karpathy/llama2.c/blob/master/LICENSE" },
    contextTokens: 128,
    serveContextTokens: 128,
    tools: false,
    purpose: "test",
    trainable: true,
  },
];

export function localModel(id: string): LocalModel | null {
  return LOCAL_MODELS.find((m) => m.id === id) ?? null;
}

export function modelDownloadUrl(m: LocalModel): string {
  const { host, repo, revision, path } = m.source;
  return `https://${host}/${repo}/resolve/${revision}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The file name a model has in the models volume: its digest, nothing an owner or app chose. */
export function modelFileName(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("not a sha256");
  return `sha256-${sha256}.gguf`;
}

/** Memory the server needs for a model at its serve context (weights plus a working margin). */
export function memoryNeededMiB(m: LocalModel): number {
  return Math.ceil((m.sizeBytes * 1.15) / (1 << 20)) + 256 + Math.ceil(m.serveContextTokens / 64);
}

/**
 * An honest first guess at generation speed on this box, replaced by the measured rate once the
 * model has answered here. Generation is bound by memory bandwidth: every token reads the weights.
 */
export function expectedTokensPerSecond(m: LocalModel, hw: { cpus: number; gpuMemoryMiB: number | null }): number {
  const bytes = Math.max(m.sizeBytes, 1);
  // Assume ~3 GB/s of usable bandwidth per core up to 24 GB/s; a GPU's VRAM ~300 GB/s, half usable.
  const gbps = hw.gpuMemoryMiB !== null && hw.gpuMemoryMiB * (1 << 20) > m.sizeBytes * 1.2 ? 150 : Math.min(24, 3 * Math.max(1, hw.cpus));
  return Math.max(0.1, Math.round(((gbps * 1e9) / bytes) * 10) / 10);
}
