/**
 * Browser-compatible transaction types
 * Only exports types/interfaces needed for browser usage
 */

import { Note, UnshieldNote } from './note';

export interface InputOutputBundle {
  inputs: Note[];
  outputs: (Note | UnshieldNote)[];
}
