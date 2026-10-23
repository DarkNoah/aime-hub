import { createContext, useContext, type ComponentProps } from 'react';

export type ImageEditSource = {
  src: string;
  name: string;
  referrerPolicy?: ComponentProps<'img'>['referrerPolicy'];
};

export type ImageEditReceiver = (image: ImageEditSource) => void;

export const ImageEditContext = createContext<{
  available: boolean;
  open: ImageEditReceiver;
  register: (receiver: ImageEditReceiver) => () => void;
} | null>(null);

export function useImageEdit() {
  return useContext(ImageEditContext);
}
