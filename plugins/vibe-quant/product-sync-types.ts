export interface ProductSyncOption {
  key: string;
  total: number;
  ready: number;
  selected: boolean;
  selectedContracts: number;
}

export interface ProductSyncOverview {
  options: ProductSyncOption[];
  matched: number;
  ready: number;
  selectedContracts: number;
}

export interface ProductSyncContract {
  symbol: string;
  name: string;
  selected: boolean;
  ready: boolean;
  expired: boolean;
  firstBarAt?: number;
  lastBarAt?: number;
  outcome?: ProductSyncResult['outcome'];
}

export interface ProductSyncContractPage {
  items: ProductSyncContract[];
  nextCursor: string | null;
}

export interface ProductSyncTarget {
  symbol: string;
  /** Last committed bar start time, by native duration in seconds. */
  latest: Record<string, number>;
}

export interface ProductSyncResult extends ProductSyncTarget {
  firstBarAt: number;
  lastBarAt: number;
  outcome: 'ready' | 'partial' | 'empty' | 'error';
}
