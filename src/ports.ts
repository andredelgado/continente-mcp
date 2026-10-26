import type { Product, BrowserStatus, CartMutationResult, FavoritesCache, Result, ToolError, CheckoutSummary, CouponList, CouponSelection, PickupSlots, PickupStoreChange, PickupStores } from './domain/index.js';

export type Logger = (message: string) => void;
export interface Clock { now(): Date; }
export interface FavoritesStore {
  load(): Promise<Result<FavoritesCache | null, ToolError>>;
  save(cache: FavoritesCache): Promise<Result<void, ToolError>>;
}
export interface SessionService {
  run<T>(operation: () => Promise<T>): Promise<T>;
  refreshAuthentication(): Promise<boolean>;
  closeBrowserSession(): Promise<void>;
  shutdown?(): Promise<void>;
  getStatus?(): Promise<BrowserStatus>;
}
export interface CatalogGateway {
  fetchProductDetails?(reference: string): Promise<Result<{ html: string; url: string }, ToolError>>;
  /** The label tab a product page links to (ingredients, allergens, nutrition). */
  fetchProductLabel?(url: string): Promise<Result<string, ToolError>>;
  /** `accept` limits which products count towards `limit`, so filtered searches read enough pages. */
  searchProducts(query: string, limit: number, resume?: SearchResume, accept?: (product: Product) => boolean): Promise<Result<RetrievedPages, ToolError>>;
}
export interface RetrievedPages {
  pages: string[]; failures: ToolError[]; nextCursor?: string | null; completeness?: 'complete' | 'partial' | 'unknown';
  /** Search only: the position of each page's first result in the full list. */
  starts?: number[];
  /** Search only: the results grid URL without its position, when the website gave one. */
  grid?: string | null;
}
/** Where a search continues: a position in the full result list, read from the grid when known. */
export interface SearchResume { start: number; grid: string | null; }
export interface FavoritesGateway { fetchFavorites(): Promise<Result<RetrievedPages, ToolError>>; }
export type PreparedCartMutation = () => Promise<Result<unknown, ToolError>>;
export interface CartGateway {
  fetchCart(): Promise<Result<unknown, ToolError>>;
  fetchProductForm(reference: string): Promise<Result<unknown, ToolError>>;
  fetchCartControls(): Promise<Result<string, ToolError>>;
  submitCartMutation(action: string, parameters: URLSearchParams, method: 'GET' | 'POST'): Promise<Result<unknown, ToolError>>;
  prepareCartMutation?(action: string, parameters: URLSearchParams, method: 'GET' | 'POST'): Promise<Result<PreparedCartMutation, ToolError>>;
}
export interface OrdersGateway {
  fetchOrderHistory(cursor?: string): Promise<Result<string, ToolError>>;
  fetchOrderLines(url: string): Promise<Result<string, ToolError>>;
}
export interface CouponGateway { fetchCoupons(): Promise<Result<CouponList, ToolError>>; }
export interface CouponSelectionGateway {
  setSelectedCoupons(couponIds: string[]): Promise<Result<CouponSelection, ToolError>>;
  fetchCheckoutContext(): Promise<Result<Pick<CheckoutSummary, 'loyaltyCredit' | 'selectedCouponIds'>, ToolError>>;
}
export interface PickupStoreQuery { postalCode: string; latitude: number; longitude: number; city?: string; }
export interface PickupStoreGateway { fetchPickupStores(query: PickupStoreQuery): Promise<Result<PickupStores, ToolError>>; }
export interface PickupStoreSelectionGateway {
  setPickupStore(storeId: string, recoveryWindow: PickupSlotWindow): Promise<Result<PickupStoreChange, ToolError>>;
}
export interface PickupSlotWindow { from: string; to: string; }
export interface PickupSlotGateway { fetchPickupSlots(window: PickupSlotWindow): Promise<Result<PickupSlots, ToolError>>; }
export type MutationResult = Result<CartMutationResult, ToolError>;
