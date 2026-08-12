export interface FlightSegment {
  flight_number: string;
  airline: string;
  airline_code: string;
  operated_by: string | null;
  aircraft: string | null;
  origin: string;
  origin_name: string;
  destination: string;
  destination_name: string;
  departure: string;
  arrival: string;
  departure_date: string;
  arrival_date: string;
  duration_minutes: number;
  legroom: string | null;
}

export interface FlightExtensions {
  /** `null` when Google stated nothing — which is not the same as "not included". */
  carry_on_included: boolean | null;
  /** `null` when Google stated nothing — which is not the same as zero bags. */
  checked_bags_included: number | null;
}

export interface FlightOffer {
  price: number;
  currency: string;
  airline: string;
  airline_code: string;
  is_best: boolean;
  fare_brand: string | null;
  departure: string;
  arrival: string;
  departure_date: string;
  arrival_date: string;
  duration_minutes: number;
  stops: number;
  segments: FlightSegment[];
  extensions: FlightExtensions;
  booking_token: string;
}

export interface DateGridEntry {
  date: string;
  price: number;
}

export interface DateGridResult {
  date_grid: DateGridEntry[];
  cheapest: DateGridEntry | null;
  currency: string;
  /** The departure dates actually covered — the caller should not have to infer them. */
  window: { anchor_date: string; days: number; from: string; to: string };
  /** Priced successfully, but the route has no offers that day. */
  unavailable_dates: string[];
  /** The request did not complete — NOT the same as "no flights that day". */
  failed_dates: { date: string; error: string }[];
  /** Dropped after the wall-clock budget ran out, or after a block stopped the run. */
  not_attempted_dates: string[];
}

export interface AirportResult {
  code: string;
  name: string;
  city: string;
  country: string;
}

export interface SearchFlightsOptions {
  origin: string;
  destination: string;
  departure_date: string;
  return_date?: string;
  trip_type: 'one_way' | 'round_trip';
  seat_class: 'economy' | 'premium_economy' | 'business' | 'first';
  adults: number;
  children: number;
  infants_in_seat: number;
  infants_on_lap: number;
  max_stops: 'any' | 'nonstop' | '1' | '2';
  sort_by: 'best' | 'price' | 'duration' | 'departure' | 'arrival';
  max_results: number;
  offset: number;
  currency: string;
  exclude_basic_economy: boolean;
}

export interface SearchFlightsResult {
  query: {
    origin: string;
    destination: string;
    departure_date: string;
    return_date?: string;
    trip_type: string;
    seat_class: string;
    passengers: {
      adults: number;
      children: number;
      infants_in_seat: number;
      infants_on_lap: number;
    };
  };
  total_results: number;
  showing: { offset: number; count: number };
  has_more: boolean;
  next_offset: number | null;
  flights: FlightOffer[];
}

export interface GetDateGridOptions {
  origin: string;
  destination: string;
  departure_date?: string;
  /** Held fixed while the departure date varies. Required for `round_trip`. */
  return_date?: string;
  trip_type: 'one_way' | 'round_trip';
  seat_class: 'economy' | 'premium_economy' | 'business' | 'first';
  adults: number;
  currency: string;
  /** Days in the grid, centred on the anchor. Default 7, max 31 — each day is one request. */
  window_days?: number;
}

export type SeatClass = 'economy' | 'premium_economy' | 'business' | 'first';
export type TripType = 'one_way' | 'round_trip';
