export function personalizeBytes(base: Uint8Array, trailer: Uint8Array): Uint8Array {
  const out = new Uint8Array(base.length + trailer.length);
  out.set(base, 0);
  out.set(trailer, base.length);
  return out;
}

export function personalizeStream(
  baseStream: ReadableStream<Uint8Array>,
  trailer: Uint8Array,
): ReadableStream<Uint8Array> {
  const reader = baseStream.getReader();
  let appended = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        if (!appended) {
          controller.enqueue(trailer);
          appended = true;
        }
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

export function trailerStream(
  baseStream: ReadableStream<Uint8Array>,
  trailer: Uint8Array,
  onProgress?: (bytesEmitted: number) => void,
): ReadableStream<Uint8Array> {
  const reader = baseStream.getReader();
  let appended = false;
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        if (!appended) {
          controller.enqueue(trailer);
          total += trailer.length;
          if (onProgress) onProgress(total);
          appended = true;
        }
        controller.close();
        return;
      }
      controller.enqueue(value);
      total += value.length;
      if (onProgress) onProgress(total);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}
