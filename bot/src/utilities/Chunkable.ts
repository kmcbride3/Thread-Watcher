/**
 * A utility class for chunking arrays into pages for pagination
 */
export default class Chunkable<T> {
  private pointer: number;
  private readonly chunks: T[][];

  /**
   * Create a Chunkable instance
   * @param chunks Array of chunk arrays (pages)
   */
  constructor(chunks: T[][]) {
    this.chunks = chunks;
    this.pointer = 0;
  }

  /**
   * Create a Chunkable from an array with a specific chunk size
   * @param array The array to chunk
   * @param size Size of each chunk (page)
   */
  static from<U>(array: U[], size = 10): Chunkable<U> {
    const chunks: U[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return new Chunkable<U>(chunks);
  }

  /**
   * Get the current chunk
   */
  get current(): T[] {
    return this.chunks[this.pointer] || [];
  }

  /**
   * Get the current pointer position
   */
  get currentPointer(): number {
    return this.pointer;
  }

  /**
   * Get the total number of pages
   */
  get pages(): number {
    return this.chunks.length;
  }

  /**
   * Move to the next page with bounds checking
   * @returns The next chunk or an empty array if at the end
   */
  nextPage(): T[] {
    if (this.pointer < this.chunks.length - 1) {
      this.pointer++;
    }
    return this.current;
  }

  /**
   * Move to the previous page with bounds checking
   * @returns The previous chunk or the first chunk if already at the beginning
   */
  previousPage(): T[] {
    if (this.pointer > 0) {
      this.pointer--;
    }
    return this.current;
  }

  /**
   * Legacy method: Move forward one page without bounds checking
   * @deprecated Use nextPage() instead
   */
  forwards(): T[] {
    this.pointer++;
    return this.chunks[this.pointer];
  }

  /**
   * Legacy method: Move back one page with bounds checking
   * @deprecated Use previousPage() instead
   */
  back(): T[] {
    if (this.pointer === 0) {
      return this.chunks[0];
    }
    this.pointer--;
    return this.chunks[this.pointer];
  }

  /**
   * Iterator-style method that advances the pointer if there are more items
   * @returns The current chunk and advances pointer if more exist, false if at the end
   */
  next(): T[] | false {
    if (this.pointer < this.chunks.length - 1) {
      return this.chunks[this.pointer++];
    }
    return false;
  }

  /**
   * Check if there is a previous page and if so, move to it
   * @returns The previous chunk if available, false if already at the beginning
   */
  hasPreviousAndReverse(): T[] | false {
    if (this.pointer > 0) {
      this.pointer--;
      return this.current;
    }
    return false;
  }

  /**
   * Set the pointer to a specific position with bounds checking
   * @param position The position to set the pointer to
   * @returns The chunk at the specified position
   */
  setPointer(position: number): T[] {
    if (position >= 0 && position < this.chunks.length) {
      this.pointer = position;
    }
    return this.current;
  }

  /**
   * Reset the pointer to the first page
   * @returns The first chunk
   */
  reset(): T[] {
    this.pointer = 0;
    return this.current;
  }

  /**
   * Go to the last page
   * @returns The last chunk
   */
  last(): T[] {
    this.pointer = Math.max(0, this.chunks.length - 1);
    return this.current;
  }
}
