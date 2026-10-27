import { toast } from 'sonner';
import {
  MarketSignalToast,
  type SignalToastProps,
} from '@/components/notifications/market-signal-toast';

/** Shared by live delivery and local replay. Only confirmation dismisses a signal. */
export function showMarketSignalToast(props: SignalToastProps) {
  return toast.custom(() => <MarketSignalToast {...props} />, {
    id: props.id,
    duration: Infinity,
    dismissible: false,
    closeButton: false,
    className: 'w-full',
  });
}
