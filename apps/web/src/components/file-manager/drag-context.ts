import { createContext } from 'react';

/** Identifies the workspace shared by the file list and its composer. */
export const WorkspaceDragContext = createContext<string | null>(null);
