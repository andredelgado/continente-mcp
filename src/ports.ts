import type { SignInWindowState } from './session/sign-in-window.js';
import type { Product, BrowserStatus, CartMutationResult, CouponList, CouponSelectionResult, FavoritesCache, Result, ToolError } from './domain/index.js';

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
  /** Whether the last sign-in needed the person to confirm they are not a robot, and whether a window opened for it. */
  signInPrompt?(): SignInWindowState | null;
}
export interface CatalogGateway {
  fetchProductDetails?(reference: string): Promise<Result<{ html: string; url: string }, ToolError>>;
  /** The label tab a product page links to (ingredients, allergens, nutrition). */
  fetchProductLabel?(url: string): Promise<Result<string, ToolError>>;
  /**
   * `accept` limits which products count towards `limit`, so filtered searches read enough pages.
   * `site` is ordering and narrowing the website applies itself.
   */
  searchProducts(query: string, limit: number, resume?: SearchResume, accept?: (product: Product) => boolean, site?: SiteSearchOptions): Promise<Result<RetrievedPages, ToolError>>;
}
export interface RetrievedPages {
  pages: string[]; failures: ToolError[]; nextCursor?: string | null; completeness?: 'complete' | 'partial' | 'unknown';
  /** Search only: the position of each page's first result in the full list. */
  starts?: number[];
  /** Search only: the results grid URL without its position, when the website gave one. */
  grid?: string | null;
}
/** Ordering and narrowing the website applies to a search: its unit-price sort and its promotion filter. */
export interface SiteSearchOptions { sort?: 'unit_price'; promotion?: 'discount' | 'below_recommended_price'; }
/** Where a search continues: a position in the full result list, read from the grid when known. */
export interface SearchResume { start: number; grid: string | null; }
export interface FavoritesGateway { fetchFavorites(): Promise<Result<RetrievedPages, ToolError>>; }
export type PreparedCartMutation = () => Promise<Result<unknown, ToolError>>;
/** The cart write a request is for. The client accepts only that operation's endpoint and method. */
export type CartOperation = 'add' | 'update' | 'remove' | 'clear';
export interface CartGateway {
  fetchCart(): Promise<Result<unknown, ToolError>>;
  fetchProductForm(reference: string): Promise<Result<unknown, ToolError>>;
  fetchCartControls(): Promise<Result<string, ToolError>>;
  submitCartMutation(action: string, parameters: URLSearchParams, operation: CartOperation): Promise<Result<unknown, ToolError>>;
  prepareCartMutation?(action: string, parameters: URLSearchParams, operation: CartOperation): Promise<Result<PreparedCartMutation, ToolError>>;
}
export interface OrdersGateway {
  fetchOrderHistory(cursor?: string): Promise<Result<string, ToolError>>;
  fetchOrderLines(url: string): Promise<Result<string, ToolError>>;
}
export type MutationResult = Result<CartMutationResult, ToolError>;
export interface CouponGateway {
  /** The account's coupons, each marked as selected in the cart or not when the cart's coupon form can be read. */
  fetchCoupons(): Promise<Result<CouponList, ToolError>>;
  /** Make exactly these coupons the cart's selection. */
  setSelectedCoupons(couponIds: string[]): Promise<Result<CouponSelectionResult, ToolError>>;
}
