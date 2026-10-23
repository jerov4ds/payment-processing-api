import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export async function atomicWriteFile(
  filePath: string,
  contents: string,
): Promise<void> {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.tmp`,
  );
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await syncDirectory(path.dirname(filePath));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
