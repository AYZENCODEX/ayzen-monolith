import crypto from "node:crypto";
import { iso } from "./store";
import type { AdvancedEngineStore } from "./advanced-store";
import type { GeoContextEvent, GeoPoint, GeoRegion, Geofence } from "./advanced-types";

function validPoint(point: GeoPoint): boolean {
  return Number.isFinite(point.latitude) && point.latitude >= -90 && point.latitude <= 90 &&
    Number.isFinite(point.longitude) && point.longitude >= -180 && point.longitude <= 180;
}

function contains(point: GeoPoint, polygon: GeoPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    const intersect = ((a.longitude > point.longitude) !== (b.longitude > point.longitude)) &&
      point.latitude < (b.latitude - a.latitude) * (point.longitude - a.longitude) / (b.longitude - a.longitude) + a.latitude;
    if (intersect) inside = !inside;
  }
  return inside;
}

export class GeoIntelligenceEngine {
  constructor(private readonly store: AdvancedEngineStore) {}

  registerRegion(region: GeoRegion): GeoRegion {
    if (region.polygon.length < 3 || region.polygon.some((point) => !validPoint(point))) throw new Error("A region needs at least three valid points");
    this.store.regions.set(region.id, { ...region, polygon: [...region.polygon] });
    return this.store.regions.get(region.id)!;
  }

  registerGeofence(geofence: Geofence): Geofence {
    if (!this.store.regions.has(geofence.regionId)) throw new Error("Geofence region not found");
    this.store.geofences.set(geofence.id, geofence);
    return geofence;
  }

  evaluate(subjectId: string, point: GeoPoint, previousPoint?: GeoPoint, occurredAt = new Date()): GeoContextEvent {
    if (!validPoint(point)) throw new Error("Invalid geographic point");
    const regionIds = [...this.store.regions.values()].filter((region) => contains(point, region.polygon)).map((region) => region.id);
    const previousRegions = previousPoint && validPoint(previousPoint)
      ? new Set([...this.store.regions.values()].filter((region) => contains(previousPoint, region.polygon)).map((region) => region.id))
      : new Set<string>();
    const geofenceEvents: Array<"ENTER" | "EXIT"> = [];
    for (const fence of this.store.geofences.values()) {
      const nowInside = regionIds.includes(fence.regionId);
      const wasInside = previousRegions.has(fence.regionId);
      if (nowInside && !wasInside && fence.enter !== false) geofenceEvents.push("ENTER");
      if (!nowInside && wasInside && fence.exit !== false) geofenceEvents.push("EXIT");
    }
    const event = { id: crypto.randomUUID(), subjectId, point, regionIds, geofenceEvents, occurredAt: iso(occurredAt) };
    this.store.geoEvents.set(event.id, event);
    return event;
  }

  events(subjectId?: string): GeoContextEvent[] {
    return [...this.store.geoEvents.values()].filter((event) => !subjectId || event.subjectId === subjectId);
  }
}