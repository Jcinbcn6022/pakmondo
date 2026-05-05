import React, { useState, useEffect, createContext, useContext, useRef } from "react";
import {
  Compass, Backpack, MapPin, Settings, ShoppingCart,
  ArrowLeft, Plus, Check, X, ChevronRight, ChevronDown, User, Lock, Mail, CreditCard,
  Tag, Layers, Globe, Calendar, Trash2, LogOut, Map as MapIcon, Pencil, Download, Cloud,
  Tent, Snowflake, Waves, TreePine, Flame, Mountain, AlertTriangle, Menu
} from "lucide-react";
import { createClient } from "@supabase/supabase-js";

// === SUPABASE CLIENT ===
// Connects to your Supabase project. The publishable/anon key is safe to ship
// in client code — Row Level Security policies in the database control what
// each user can actually access.
//
// Use localStorage (not sessionStorage) so the user stays signed in across
// browser tab closes and app switches. iOS Safari aggressively purges
// sessionStorage when the PWA is backgrounded, which previously caused
// data loss when switching apps.
const SUPABASE_URL = "https://cqmdsbxccgxxznnhzoip.supabase.co";
const SUPABASE_KEY = "sb_publishable_yLnqUTGXr7UBkjeVufDliQ_50CQQM8E";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

// === SUPABASE SERVICE ===
// All backend calls go through this object. Swap implementation here when
// migrating other features (items, kits, etc.) from localStorage to Supabase.
const supabaseService = {
  // --- AUTH ---
  signUp: async ({ email, password, username, name, region }) => {
    // First check if username is taken — RLS lets any authenticated user read
    // profiles, but we need to do this BEFORE signup. We'll rely on the unique
    // constraint as the final check, and use a public RPC-style query here.
    // Since unauthenticated reads aren't allowed, we just attempt signup and
    // catch the unique violation.
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { username, name, region }, // passed to handle_new_user trigger
      },
    });
    if (error) {
      return { error: error.message };
    }
    // The trigger should have created a profile row. If username was taken,
    // the trigger will have errored and the user will exist in auth but no
    // profile row. We check by querying profiles.
    if (data.user) {
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", data.user.id)
        .single();
      if (profileError || !profile) {
        return { error: "Username already taken — try another" };
      }
      return { user: data.user, profile };
    }
    return { error: "Signup failed" };
  },

  signIn: async ({ email, password }) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    if (data.user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", data.user.id)
        .single();
      return { user: data.user, profile };
    }
    return { error: "Login failed" };
  },

  signOut: async () => {
    await supabase.auth.signOut();
  },

  // Send a password-reset email. Supabase emails a magic link to the address;
  // when clicked, it lands on the app at /?reset=true with a temporary session
  // active, allowing the user to set a new password.
  resetPasswordForEmail: async (email) => {
    const redirectTo = typeof window !== "undefined"
      ? `${window.location.origin}?reset=true`
      : undefined;
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
    if (error) return { error: error.message };
    return { ok: true };
  },

  // Apply a new password (requires the user to be in the post-reset session
  // that arrives when they click the email link).
  updatePassword: async (newPassword) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) return { error: error.message };
    return { ok: true };
  },

  getSession: async () => {
    const { data } = await supabase.auth.getSession();
    if (!data?.session?.user) return null;
    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", data.session.user.id)
      .single();
    return profile ? { user: data.session.user, profile } : null;
  },

  // --- USER LOOKUP (for share recipient search) ---
  findUser: async (username) => {
    const { data } = await supabase
      .from("profiles")
      .select("*")
      .ilike("username", username.trim())
      .maybeSingle();
    return data;
  },

  // --- SHARES ---
  sendShare: async ({ kind, payload, recipientUsername, mode, fromProfile }) => {
    let toUserId = null;
    let shareCode = null;

    if (recipientUsername.startsWith("code:")) {
      // Code-based share — anyone authenticated can read it via share_code
      shareCode = recipientUsername.replace(/^code:/, "");
    } else {
      // Username-based — resolve to user_id
      const recipient = await supabaseService.findUser(recipientUsername);
      if (!recipient) return { error: "User not found" };
      toUserId = recipient.id;
    }

    const { data, error } = await supabase.from("shares").insert({
      from_user_id: fromProfile.id,
      from_username: fromProfile.username,
      from_name: fromProfile.name,
      from_region: fromProfile.region,
      to_username: shareCode ? `code:${shareCode}` : recipientUsername,
      to_user_id: toUserId,
      kind,
      mode,
      payload,
      share_code: shareCode,
    }).select().single();

    if (error) return { error: error.message };
    return { share: data };
  },

  fetchInbox: async (userId) => {
    const { data, error } = await supabase
      .from("shares")
      .select("*")
      .or(`to_user_id.eq.${userId},from_user_id.eq.${userId}`)
      .order("sent_at", { ascending: false });
    if (error) return [];
    return data || [];
  },

  redeemCode: async (code, userId) => {
    // Look up share by code, then claim it for this user
    const { data: share } = await supabase
      .from("shares")
      .select("*")
      .eq("share_code", code.trim().toUpperCase())
      .eq("status", "pending")
      .maybeSingle();
    if (!share) return { error: "Code not found or already used" };
    // Update to_user_id so it appears in this user's inbox
    const { data, error } = await supabase
      .from("shares")
      .update({ to_user_id: userId })
      .eq("id", share.id)
      .select()
      .single();
    if (error) return { error: error.message };
    return { share: data };
  },

  setShareStatus: async (id, status, extras = {}) => {
    const updates = { status };
    if (status === "imported") updates.imported_at = new Date().toISOString();
    if (status === "declined") updates.declined_at = new Date().toISOString();
    Object.assign(updates, extras);
    const { data, error } = await supabase
      .from("shares")
      .update(updates)
      .eq("id", id)
      .select()
      .single();
    if (error) return { error: error.message };
    return { share: data };
  },

  // ============== LIBRARY ==============
  // Fetch the list of activity types (defaults + user-created) for the dropdown
  fetchActivities: async () => {
    const { data, error } = await supabase
      .from("library_activities")
      .select("id, name, is_default")
      .order("is_default", { ascending: false })
      .order("name", { ascending: true });
    if (error) return [];
    return data || [];
  },

  // Create a new custom activity (or no-op if a matching one already exists, case-insensitive)
  ensureActivity: async (name, userId) => {
    const trimmed = name.trim();
    if (!trimmed) return { error: "Activity name required" };
    // Check existing first
    const { data: existing } = await supabase
      .from("library_activities")
      .select("name")
      .ilike("name", trimmed)
      .maybeSingle();
    if (existing) return { name: existing.name };
    // Insert new
    const { data, error } = await supabase
      .from("library_activities")
      .insert({ name: trimmed, is_default: false, created_by: userId })
      .select("name")
      .single();
    if (error) return { error: error.message };
    return { name: data.name };
  },

  // Submit content to the library (status starts as 'pending', awaiting admin review)
  publishToLibrary: async ({ kind, title, description, activity, payload, publisher }) => {
    const { data, error } = await supabase
      .from("library_items")
      .insert({
        publisher_user_id: publisher.id,
        publisher_username: publisher.username,
        publisher_region: publisher.region,
        kind,
        title: title.trim(),
        description: (description || "").trim() || null,
        activity: activity.trim(),
        payload,
        status: "pending",
      })
      .select()
      .single();
    if (error) return { error: error.message };
    return { item: data };
  },

  // Fetch a user's own submissions (any status — they always see their own)
  fetchMySubmissions: async (userId) => {
    const { data, error } = await supabase
      .from("library_items")
      .select("*")
      .eq("publisher_user_id", userId)
      .order("created_at", { ascending: false });
    if (error) return [];
    return data || [];
  },

  // === ADMIN ONLY ===
  // Fetch ALL submissions across all users, regardless of status. Used by
  // the admin review screen. Backend RLS must allow profiles.is_admin=true
  // to read non-approved rows for this to actually return non-approved.
  fetchAllSubmissions: async (statusFilter = null) => {
    let q = supabase
      .from("library_items")
      .select("*")
      .order("created_at", { ascending: false });
    if (statusFilter) q = q.eq("status", statusFilter);
    const { data, error } = await q;
    if (error) return { error: error.message, items: [] };
    return { items: data || [] };
  },

  // === ADMIN ONLY ===
  // Set a submission's status. Used to approve / reject pending submissions.
  // RLS must allow admins to update library_items rows.
  setSubmissionStatus: async (id, status, reason = null) => {
    const updates = { status };
    if (status === "rejected" && reason) updates.rejection_reason = reason;
    if (status === "approved") updates.rejection_reason = null;
    const { error } = await supabase
      .from("library_items")
      .update(updates)
      .eq("id", id);
    if (error) return { error: error.message };
    return { ok: true };
  },

  // Delete a submission (publisher's own)
  deleteSubmission: async (id) => {
    const { error } = await supabase.from("library_items").delete().eq("id", id);
    if (error) return { error: error.message };
    return { ok: true };
  },

  // Browse the public library — only returns approved items.
  // Filters: kind, activity, region. All optional.
  fetchLibrary: async ({ kind, activity, region, limit = 60 } = {}) => {
    let q = supabase
      .from("library_items")
      .select("id, publisher_user_id, publisher_username, publisher_region, kind, title, description, activity, view_count, import_count, created_at")
      .eq("status", "approved")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (kind) q = q.eq("kind", kind);
    if (activity) q = q.eq("activity", activity);
    if (region) q = q.eq("publisher_region", region);
    const { data, error } = await q;
    if (error) return [];
    return data || [];
  },

  // Fetch full library item details (including payload)
  fetchLibraryItem: async (id) => {
    const { data, error } = await supabase
      .from("library_items")
      .select("*")
      .eq("id", id)
      .eq("status", "approved")
      .maybeSingle();
    if (error) return null;
    return data;
  },

  // Atomically increment a counter
  incrementLibraryCount: async (id, field) => {
    await supabase.rpc("increment_library_count", { item_id: id, field });
  },

  // Submit a report against a library item
  submitReport: async ({ libraryItemId, reporterId, reason }) => {
    const { error } = await supabase.from("reports").insert({
      library_item_id: libraryItemId,
      reporter_user_id: reporterId,
      reason: reason || null,
    });
    if (error) return { error: error.message };
    return { ok: true };
  },

  // ============== PERSONAL DATA SYNC ==============
  // Each user has their own private inventory/categories/kits/packlists/cart.
  // RLS in the database ensures user A can never see user B's data.
  //
  // The shape of records stored matches the shape of records used in app
  // state — except database column names use snake_case. The helpers below
  // translate between camelCase (app) and snake_case (db) automatically.

  // Load every personal data table for the current user. Called on login.
  // Returns: { items, categories, kits, packlists, cart }
  loadPersonalData: async (userId) => {
    if (!userId) return { items: [], categories: [], kits: [], packlists: [], cart: [] };
    const [itemsRes, catsRes, kitsRes, plRes, cartRes] = await Promise.all([
      supabase.from("items").select("*").eq("user_id", userId),
      supabase.from("categories").select("*").eq("user_id", userId),
      supabase.from("kits").select("*").eq("user_id", userId),
      supabase.from("packlists").select("*").eq("user_id", userId),
      supabase.from("cart").select("*").eq("user_id", userId),
    ]);

    // Translate snake_case columns back to camelCase + spread payload
    const fromRow = (row) => {
      if (!row) return null;
      const { user_id, created_at, updated_at, remind_days, item_ids, kit_ids, category_ids, linked_from, payload, ...rest } = row;
      const out = {
        ...rest,
        ...(remind_days != null ? { remindDays: remind_days } : {}),
        ...(item_ids != null ? { itemIds: item_ids } : {}),
        ...(kit_ids != null ? { kitIds: kit_ids } : {}),
        ...(category_ids != null ? { categoryIds: category_ids } : {}),
        ...(linked_from != null ? { linkedFrom: linked_from } : {}),
      };
      // Merge any fields the payload column was holding for forward-compat
      if (payload && typeof payload === "object") Object.assign(out, payload);
      return out;
    };

    return {
      items: (itemsRes.data || []).map(fromRow),
      categories: (catsRes.data || []).map(fromRow),
      kits: (kitsRes.data || []).map(fromRow),
      packlists: (plRes.data || []).map(fromRow),
      cart: (cartRes.data || []).map(fromRow),
    };
  },

  // Helpers — convert app-shape entity into DB-shape row (with user_id)
  _itemToRow: (item, userId) => {
    const { id, name, category, weight, quantity, size, packed, consumable, expiry, remindDays, region, linkedFrom, ...rest } = item;
    return {
      id, user_id: userId,
      name: name || "",
      category: category || null,
      weight: weight || null,
      quantity: typeof quantity === "number" ? quantity : 1,
      size: size || null,
      packed: !!packed,
      consumable: !!consumable,
      expiry: expiry || null,
      remind_days: remindDays != null ? remindDays : null,
      region: region || null,
      linked_from: linkedFrom || null,
      payload: Object.keys(rest).length ? rest : null,
      updated_at: new Date().toISOString(),
    };
  },

  _categoryToRow: (cat, userId) => {
    const { id, name, icon, region, linkedFrom, ...rest } = cat;
    return {
      id, user_id: userId,
      name: name || "",
      icon: icon || "tag",
      region: region || null,
      linked_from: linkedFrom || null,
      payload: Object.keys(rest).length ? rest : null,
      updated_at: new Date().toISOString(),
    };
  },

  _kitToRow: (kit, userId) => {
    const { id, name, category, itemIds, region, linkedFrom, ...rest } = kit;
    return {
      id, user_id: userId,
      name: name || "",
      category: category || null,
      item_ids: itemIds || [],
      region: region || null,
      linked_from: linkedFrom || null,
      payload: Object.keys(rest).length ? rest : null,
      updated_at: new Date().toISOString(),
    };
  },

  _packlistToRow: (pl, userId) => {
    const { id, name, notes, kitIds, itemIds, categoryIds, dest, date, type, region, linkedFrom, ...rest } = pl;
    return {
      id, user_id: userId,
      name: name || "",
      notes: notes || null,
      kit_ids: kitIds || [],
      item_ids: itemIds || [],
      category_ids: categoryIds || [],
      dest: dest || null,
      date: date || null,
      type: type || null,
      region: region || null,
      linked_from: linkedFrom || null,
      payload: Object.keys(rest).length ? rest : null,
      updated_at: new Date().toISOString(),
    };
  },

  _cartToRow: (line, userId) => {
    const { id, name, qty, ...rest } = line;
    return {
      id, user_id: userId,
      name: name || "",
      qty: typeof qty === "number" ? qty : 1,
      payload: Object.keys(rest).length ? rest : null,
      updated_at: new Date().toISOString(),
    };
  },

  // Generic upsert — inserts or updates a single row in any table.
  // Returns { ok: true } on success, { error } on failure.
  upsertItem: async (item, userId) => {
    const row = supabaseService._itemToRow(item, userId);
    const { error } = await supabase.from("items").upsert(row);
    return error ? { error: error.message } : { ok: true };
  },
  upsertCategory: async (cat, userId) => {
    const row = supabaseService._categoryToRow(cat, userId);
    const { error } = await supabase.from("categories").upsert(row);
    return error ? { error: error.message } : { ok: true };
  },
  upsertKit: async (kit, userId) => {
    const row = supabaseService._kitToRow(kit, userId);
    const { error } = await supabase.from("kits").upsert(row);
    return error ? { error: error.message } : { ok: true };
  },
  upsertPacklist: async (pl, userId) => {
    const row = supabaseService._packlistToRow(pl, userId);
    const { error } = await supabase.from("packlists").upsert(row);
    return error ? { error: error.message } : { ok: true };
  },
  upsertCartLine: async (line, userId) => {
    const row = supabaseService._cartToRow(line, userId);
    const { error } = await supabase.from("cart").upsert(row);
    return error ? { error: error.message } : { ok: true };
  },

  // Delete helpers
  deleteItem:     async (id) => { const { error } = await supabase.from("items").delete().eq("id", id);      return error ? { error: error.message } : { ok: true }; },
  deleteCategory: async (id) => { const { error } = await supabase.from("categories").delete().eq("id", id); return error ? { error: error.message } : { ok: true }; },
  deleteKit:      async (id) => { const { error } = await supabase.from("kits").delete().eq("id", id);       return error ? { error: error.message } : { ok: true }; },
  deletePacklist: async (id) => { const { error } = await supabase.from("packlists").delete().eq("id", id);  return error ? { error: error.message } : { ok: true }; },
  deleteCartLine: async (id) => { const { error } = await supabase.from("cart").delete().eq("id", id);       return error ? { error: error.message } : { ok: true }; },
};

const C = {
  paper: "#EFE7D6",
  paperDeep: "#E3D6B8",
  ink: "#1A2421",
  inkSoft: "#2C3A33",
  forest: "#2D4A3E",
  forestDeep: "#1E3329",
  forestBright: "#3F8B5C", // clearer mid-green for ticked checkboxes / status fills
  rust: "#B8451F",
  ochre: "#C99A4F",
  muted: "#8B7E66",
  line: "#B8A982",
};

const F = {
  display: "Georgia, 'Times New Roman', serif",
  body: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
};

const STORAGE_KEY = "pakmondo:appstate";

// Embedded PakMondo logo — black + rust on transparent background.
// Stored inline so the build is self-contained (no separate asset hosting needed).
const LOGO_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAABLAAAAJHCAYAAACAZq9UAAEAAElEQVR42uzdd5wUVdYG4Pfcqk6TmBlgJAgCgiKiiLqmVUEUM0F0MKw5IEbEHFabNud1jbtm3TV8zppdEybMqxiXNaAoQUBymNxddc/3R1ePA4ISZpie6ffZXy04zPR0V92quvfUuecCRERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERL9FuAuIiIiIiIiIiCirqWomiMVgFhERERERrRUOIlrRsYrH4wIAEyZM0ODPrDh+mffzO98ja/P9a/G7pak/i4gAgAIQVYWIKJsf0bpRVRERfPnaPWWLvvj88MKybh9uf9SFH6ZPLfDcorVuTxv63teU96xV3b9Wfv3GX2/L95+WOJbZ3G4y+yKRSGjQByEiIiIiWiOy0t9NPB438XjcgIFforUYpEIgBq/ffOpRE8dsVffQ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DxWhX2HVgd679xxTruqwObc9juPYHM/62aDi8bipqKiwr732WtfJkydfUVNTo8aw2wjAB+Bss802zz799NMPAzAVFRXsoxEREW0A7IlksQkTJigA5OXlWRZxpyYm9fX1dtKkSVcfc8wxRwGw5eXlvB7kbGsQCKDLX7hrcGzptENjqSotC3viWQHgwWRBzEAB+FD4QTKOiMAoIBB0DPtSYpegQyQV7VA77dKjbrt0mBhRZmG1nRYKANZaZQBrw+3zRCIBVcUFF1xw19y5c7cwxqiq5nTdRBGx1lqna9euS8ePH3+ViHjxeDxziSIiIqJmxgFrFpswYYIAQE1NDVe1oSZlrRUR0eXLl+Odd945UVXdiooKBdNWco6qClTx+v3X7lL085QJsZhX2i5SrR39pBjJg3VSaOkZzMGKX3Ack5m+03BBFLWAn0KXcLXE/Eq/k1NdUrrg0z9NWWJLRURZD6tt9VlyadpaME2vRa7JwQMNO2bMmGFff/31gdZaq6qSyzM4g9pfKC4urho9evSYI4444uNMgXuemkRERBvofsxdkL0aZWAxeEXNwRERO3v27B133XXX00TExuNcwS2XqKqIiAIIhWf958h8LNlG6qpsaURNtQkhrDWAZupetSwB4FjA0V8G9z6A9DpoClcU7SMpk/JhwzVLh8+9afTZqhpNJBJWGZglWmOZqYOPPvroRi+++OItNTU1YoxBrmc0qqq6rmu22267y2+55ZYKa63D4BUREdGGxQBWKxEMMomavGklk0n9+uuv4zfeeGPXRCLBjJXcG5SZj28646CNvIUH1yWrbMewSlgFdY4DF7UwNoTsif8oNFilXlVhxSIlLhxjYPx6RBxHYpKSGJLh0NIfTr9u3BEnqqpMYGCWaI0lEgkJh8N68803/3nOnDk9jTG+qubsfUFEMtlXTrdu3d577bXXbrPWOqrK4BUREdEGxoFqKxljMoBFTd6ogukpxhi7dOnSkocffnhCKBTSRCLBnZMbx19ERN967rleds6Us01tVVmR+oiEVHz4KLS1sBJpyHDKBlYUKgoxChiBKgDfg28NHAkh39ajczgljq237cO2XXTx9MsuuPiyvRKJhGVgtg10WHKwFuSGvvfH43EjIv6hhx56zLfffnuyqlpVNbk6dTAIXqm1VkpLS1MnnHDCuSJSF4/H2S8jIiJqif4gdwE7sZTbVNVYa+20adOOO+KII3YCoOXl5Q73TBs+5oCIiL48ZWZpySf3jyvS5dvV+klbElUTsik4okhHh7JrcUoRgaz0nhSAZ334qoBauOKhJGINUmr/0DHccUDNZ/FJrzzRM5FIWBZ1J1q9oJ6Tzp49u+Prr79+VWVlZSioOZez542IwFprY7GY7LzzzvEJEyZ8yLpXRERELYcBrNbBOo7jcTdQc8hk4lRVVTkfffTRma7ralDQndromCw47k7eC9ccG66ce7orntMhmpSY1sFRD6J+o5wrzbp3LyLIZIQYERjHQMVAARibRKFTj4JwvRRF6rVfbPEf6955bMxU1Uh6BTsGsYhW5auvvpJQKKQHHHDAhHnz5nUFYK21JpcLt6uqLyLO5ptv/veJEyde43mek0gkeH8kIiJqIQxgtZYDZYzPvUDN2Ek3APSnn34adeSRRw5Fetk5ZmG1QfF4XATQSRUP9Nt46X+PjEgSTsjY9qgV0XS5c4WBwgGgkCxdADUdjAIQlJhXCHxJ39LET6LQrRHP1mpJqF47VE4bNuefd28NQOPxCQxgtcJL1K+POzWl8vJyp6Kiwj/44IMP+eabb0611tpc7yOKiFVVp6ys7LvLLrvskmQyaeLxuIKrQhMREbUYBrCIKOiri62srIy8/fbb5wZTrdhJb2tRAFVJJBJ28jeTO7ifPjXBUW+gp/W22Kky1obgIwQfLnwJQYNAgbSG7Au1sKLw4MCHAQSIGaAYvkklBUWx6Jb/e/OxCRff/GRn1sNq1Rcp1h1qpl1bUVFh33zzzR7vvffeVbW1tZrrgUIRUVWVwsLC5KhRo04cNWrUovLycuHUQSIiopbFTnwrGXey004b6HqgCxYs2P3SSy/tD4AD/bY3KIOqutUvPHhgtO7nfZfUVmpeyJeopqDGZCYXNtqya8KdaHpLv73MJVEbr00ICwPPuIAKykwdjJeUWg/aO1a5X8cfHr7giZkaS9fDAlN5qDWcs8197xcAEg6H9dxzz71x9uzZmwVFy02O7u9Mlp8NhUKy44473n733Xe/DcCpqKhgJjwREVEWDFgp+ynSU7qImq+RBSsSVlVVRZ977rkLgmwd7pg2dozfvPX8Q0Nz/5twkMprF1MUhSFWJQgBWQgUkqWXmxXKt680rE8P8xW+WnhWkDRhiHgoi9QhqjXoXVaArdx5p9bcecJpk1VDQHoVTrYKymXxeFwA2NNOO23Q1KlTh1trc36xg8zUwS233HLyxIkTr/c8T1SVfTAiIqIswABWazlQObh8OG14wXLp+uOPP44eP378QADKLKw2cVwFgHy+FEVFCz89sD2WdHcM/ELHSsjWwjGKFFy01qSkzGyn9AqFCut7sNYiKSGE/Wp0MNVSU1uvWxQlQ72T/xs978Wne4qITpjAeliUu4LV9PDmm28WP/XUU3cEqw5Kjgew1FprunfvPvOYY475s4jMU1WuBE1ERJQlXO6CVsEiyDfI5dWAaAP03NMrEvrV1dWhDz/8cKSIfJpIJBjAau1EAHFV7z9u/3bGO6BOIradW2fCSMJRH356ab9gvmAruMZkViLMTHO0CoGBmPT7V1FE/Sr4oQLUmALkSS1ittZUJsO2Syy1bf27D5z3terZW4hUZlbhZCPJfrn2ICeYztZsnzmRSIgxxr/kkkvO/Omnn7Y0xvjW2pxcvENEYIxR3/e1sLAwecIJJxw5fvz4d8rLyx0R4dRBIiKibOkPchcQ0UodebHWYuHChQdZa0sB+Jxq1XqppkNTb/7t2l3duV8nUlVLCkPioZ2pE1GFDweAwFUva6cOrm7AueJAP/iwEDhioGIg6gHGga8GHd16+F5K6uqtU7Rs1lEfnnPYaaoq4Kp2rYa1lgeriQSZtf64ceMGffvtt+f4vp/Tqw4GDwd9x3HM5ptvfmcikXgHrHtFRESUdRjAIqKVO/IGgM6ZM2fLY445ptwYAxHhtaI1HssgUenlJ+8bUDzzxdtLXekdsnX+xqHFJqQeLJCeOigCR1OQVrjwpIjAZJqnAmotRC2q3GIkPQ+x1GKoE0HE1qKbs0Q862tZu8JIUfWPZ1xx0ZhhAuE02dZzbRIG05vmtEkkEhqLxfDvf/87sWjRoqLMqns5u0NErO/7bs+ePT/6+OOPL7PWGta9IiIiyj7stLeWA8UaWLThBokQEVtTUyMfffTRQeFwGAD4FLoVDvYFwBOqseiXzx/TrmbBgMo6328X8R2rNbDiBJOTFYDAilmrGliqgKogPeY1jbZm/EwwsDCAGtjM9EEFfChssGUqvYc0CSsOqiWMegBJcRESQVFYpAop27+oqkvpnM/H//3JtzpzVcLsjy80vj7lklAo1OQfOB6PSzgc1pEjR549a9as3QHYoP5h7jWsYJqmqqKsrGzJscceO05EqsrLyzm1mIiIKAsxgNVKcOoEtcSAcdGiRVu88cYbpcGgh9eLViRdoFy06z+uG1hqq4alxNV24RqJOQBMETQYmwmQzlxqBfEbRSZwpr/+h5U4NgXHCHwY+Kk6AAILg05ahaLaJRKJlOrQMv8Pvb64+5A3Vd0JExjAoravvLzcSSQS9sgjjzzgpZdeuq62thaSno+bq+1fVVWj0ag54IADrk8kEh8CMJw6SERElJ04IG09wQQBVqz7QtTMbQ719fVdX3zxxV25O1qXYHUx+5+vPmwf+ur98/JTdb1F6rQwVGmsDyDpwFqbvp60omtKOnClv5+FIwBEYKAIiUXYKIx6gChg6hDLS8piz9OiWH0+Fk85Y+Z9d22VSMAySEtt/bpeUVGhqpr34YcfXrB06VLXGGNzfdVB13XNLrvs8uj999//91QqlU7HIiIioqzEVQhbTzCBkSvakIECMcbY6upqZ8qUKXvHYrHnEokE64G0kmMnInaqatGcqw5LdLKLR9bWVvndC6odGIVag5CmkAQgkPSVZT3GayKyQkCpueNhqkEAq9FbNsHl0UKhkv4nCT6fqMIEAS1rBEnEEBJFmbfAzKsrtiUhr/eCL/995j3vzzznpF26L+aqhJRVN/8mbIuDBg1yJk2a5A0bNmzs999/v5uIWFXN2VUHRcS31jo9evR45fXXXz9WRFLpf+L5T0RElK34tJmyt3Ea0+Rb0GllJtsadvB938enn346qKamJpb5MvdMth82UVUN/XTtSae0WzrrtHqvWqPhehMWgeMZOJKCF9Z04fN1PJq/laCQCTA1RxLDqs5faXwjE4FA4KtFyiqsGog4UAh8AJ4KXCuIpBSdkESBVSkrKEEfnXvssgdPvvnll98vDQJybOfUpsTjcTNp0iTvySef3Pjjjz8+P5lM6u+dy22cWmtNhw4dlp144onniEiqvLzcAcDgFRERUTbHCLgLKCsbpjGw1jb5lhlYiwiMMXAcZ4XgFv3CWmsA6KJFi7Y47rjjBgaDIO6k7B6kCgD8+99vdMmrnLFnsbdEISnbLpKUpIbhWsBFCilXoGqhazlW02DAm/kfVjnaa94m8qvzdIVkrPT5bQDICrc3A08FNSmLOptEvQtUh0IodJfK8lSNdiux2DE2d6QzY+LOADRdP4yobVBVSSQS+PLLL0v+/Oc/P7xgwYKNgkB3TvYBgyC1RqNRGTp06MUXX3zx/8rLyx3WvSIiIsp+nELYeoIJOTOgEhFYaxGLxdCuXTuEw2GEQqEVBq+q+qvgVLCfVniNTLAKAFKpFFKpFJLJJOrq6lb5e13Xhed5bHBoeDJv6+vrnZ9++mlnEXk/kUhwYJ+txwsQJBJarhpedvlx5R20ZnCNIygLJZ0wDFxNwReFVRcmZeGphWuc9Pmh6fJQv5d3lFnlT0UAFYhKwyqG6ZMISK+XmnkhWeGnm+hzpl+5UeTMz3w1WITQgYErv/xOhYEVF54qkklBgXEQMYqwaxCpW25qTZ7tk58qmvr9h+Vvv/jpR7vvv+0CTiXkfbCtGD16tHFd1x8/fvwF33333R7WWh+Ak6v7Q0QsADNgwIBnH3300fsee+wx88QTT1g+xCIiIsp+DGBRtnUsESxnjQsuuAAbbbQR6urqkJeXB8dxGv7dWgvP8xqCUr7vQ1Xh+37D6/i+D9/3G7KrkskkkskkFi9ejClTpqCqqgp5eXlYuHAhZs2ahUWLFsHzPDiOkxksIddruWb249KlS3uvXOuIsssEQBKAfelvV+6ySeU3Z4bs8lC1Go0aC7E2vXqfGHhWALFwjIFAYNYrrqQr/dn8A0C1v/2GM23UIp3JiSDr0hWLmGtQr8G1wVoYx0FxxGBhXZ3UuAUoqJl16P/euO4bVb0uKOYl4JQiasWCBR38iy66aLd77rnnFM/zrDHGWJubJQ1FxFprTbdu3eYlEom4iNTH43HDYDUREVHrwAAWZVvnEqqKvn374rjjjoPrukilUg3Bq8y/r1xjJ7Oi2soBlsb/nfmZVCqFZcuWoV27dujSpQtqa2sxffp0PPXUU7jnnnswY8YMAIDjOAxiAaKqqKur6+/7fpGILGdmSvbJFG5/6N47B5Z9948rSiPJbnNrYnbjSLVxbRJQgcJAIYAjcMTAQNPBHaxP2EkzJ+6K/918n7Phz9VlSzRkX0Lga7qIu6rCUR9hWJiwA7WZ4LYganx0jIn8XFOrRUV50djPX593ztEHzb9ZzP1xtSbBABa14ut3IpFQVY317dv3poULFxYFhdtzLtUouF6oqqKwsFD32muvaw844IAvMiu2sqkQERG1DgxgtaIxag51MgEA4XAY+fn5zfJ7unTp0vD3WCyGLbbYAqeffjoOPvhgTJ48GXfddRfef//9hjpZmQyvXBwAAcDChQv7/utf/9oUwGdBfSAO6rPlwhAEFKct1nY/3Djq7KLksl0XJI3ND7kmz/hBjSiBiAkOqMIEq/g1HsWu9ZBWVrPyYKMXypwzTTk1Z+XXEpFf1fIyxjT8foXAOOmpjgIfjqZXKrTGwLcKwEcB6tE1HJIf/AK7ebEt/Xn2jPPuePBfH5x2zKivGbDNnvtfjgZe1qftGcdx/N122y0xbdq0PwTBq5yuexUKhczuu+9+wSOPPHKL7/smkUjw3CYiImpFWMS9lXTejTE5tWJQbW0tamtrAax6Kl/jLKx12RoXdM/8d1FREfr27YsjjzwSjz32GI499tiGmliZAXEuBkcA6PLlyzs88cQT3QDgq6++YqGQ7BqZIa5qZt998qjN/PmjXA3ZgoiVLu4yQC0AA5V09pVA4agHYy1MUPdKmqad/JIVKdggK31mFmKwq7kmGlg44sFIkH0mAkDgwocDQJwQUhbwrA8PBhFH0F4Wm8Jo2I7oFe7b838PnPbM1wsKwVUJqRUKVtTzjz322MGff/752Z7nWeT2KrK+qpqePXtOfO21165PJpOZBzEMYBEREbUiDGBRVnJdtyFotKrBcOZr67pl6mKt/N+ZOlpdunTBvffei6eeegplZWXwfb9hGmMOsvX19Zg6dep2xhhUVFSwgWYJ1XQ59aH/vKVP3tJpJ7rGzzO2Fu3dlBjrAeojpYC1Cqs2XXC90ap9VhXW/2Xhg98jwZYJfv1q7KeZMaFt2CTYVv1K63Y+CQAj8vuvELwf0Uwx9/RPCBQOfDiSDuv5JgQfig6mBl6yHq6k0Kn6+2HOs5fuIlyVkFqZeDxuKioqdMqUKZ3efPPNW6qqqhxjTK5msCFd8suajTbaaNEFF1xwXn19fWbFVgaviIiIWhkGsFpJHww59uTUdd2GYuoburPrOA4cx4ExBgcccACef/559OzZsyGIlYsDAN/3UVVVtVXw+dnpz5pDI/rm008X6w/vnVxo6nZZWr1UI1EIfAtPHPgi6ZiVphMN0v8zgBiopL9i1+JwGkijbVVNQWBV4CvgB0XjraRrUWmjbX0DWI2DV2Y1F0uFk/6sUEiQaKEC+DDpvWB9hERhjIGvCqsKERcFId8s9I2WtCvsJtM/O/uqq27sm0gkbDwe5/2SNjhr7Vpfb7/66itxHMeOGTPmkunTpw8QEd9am3PtN3hApaqK/Px82XPPPf928sknf4F0bTDWvSIiImqF2CFvHTIpDbnW8WzR3w8AqVQKO+ywAx555BG0b9++YVXDXFRdXd2hUXukFj5FFICqGvvFv47y5/94uq1apCVhIC9kRNQGoSH5Jei6iql9mezDlRdFWK+LlShUJD1tUQx8ceCLabZGIysE1aTR/1a6niBYwRQCCwMfDtS4sGJQ7ynqfcBaH/mOjzy/SnwVbByp3Tsy5YlLxs/UWDDgZSYWZbUg+8q//PLLt546depRNr3cYM729VRVHccxu+666+WPPPLINZ7nsd9LRETUivFG3kr6YDnXMIMpfS0aIRBBKBSC53nYeeedcffddyMSifzmCmhtlACA4zgdk8lkUTAm4EC+ZQdlEED/V3HL1qU108cUOX6oJKpaFLYCrz59wNRkDl3QXmWVbXxdg8WNC6c3fn0DpHOf1EJsCq71EIKFWSmAtrZBs8bfv3IQblVb4+9LF3NP/6yvQKYakEJgrcC3ipQFYEJwbAqlYR9efQ1KCsL2j2X+qAF3nTD+ifdnxrTR+UAb/hqEHNz/xpg1/rzBinp47LHHut17772PLFy4sF0uTx3MFK3v1KnTJy+//PLlIlKtmXRUIiIiap19I+4CytbOZ7ZwXRfWWowaNQpnnHFGZlCRS0EsAYBUKlX42WefRdg6W1ZmVbwHVKNLvnjt6Khf2T/mqs1zfaOahBEAmbpuQdBnQ7TVzG/wTRh1GoIvoYbpempTzX4jW3mTVbw/EcAE2y85WhaOCGAM6tSBioMokigNe1KdAnqWOHm9l30yPvTpg3sIRIPaOURZJ5FIwHEce999942fMWNGf2OMn8OrDqq1FsXFxVX77rvv6SLil5eXO1xRlIiIqHVjAIuytfOZdQEiVcWFF16IXXbZBdbanKuHZa3N++yzzzoCAItat1QbhASr4jlb3nzC8X71opNqU9aWhWvEqA/farr2FASSLn6VXnFzQ7w3KMQIFqdC+LnW0YX1RmslhmrPQUoiQQH1prku/Na1YVWZXSKSjl5BYARwjKSLy6sPqIURhQOgxhPUWgOxPgqkHhFTbxbXJv3+pdKh65w3T/l87pwy1sOibBSsOmjPP//8QZ9++umJ1lqrqiZXVi5exXXAhkIhs/32219z3333fQjAqaio8NlSiIiIWjeXu6B1MMZoZiCWCx3SbPucIgJrLUpLSzFs2DC89957yLWBgbU2UlVV1ZFnY0s2xHRmwee3j9uv6qfp17rWL+gSqbNR+OJD4PmANQaiBo5Nz5SRILAkwSQ6Wadfa4NXMiu8F4hByDNwrYfacAGWWovKpKtWYiKpZSiKGvWQTnlQEcBqw+qF1virqFb12+egCd6FaqMFxKTxoBUNX9cgkGckXcJdGiYOWYgYWHHg++nC7o4AKQXUWlT7CglHEYWik1RiplfgzHba24Lk4v1n/vWEy1T1XBGpy2TCsVFuOMlkMmcDMr93elRUVKiqur17975u8eLFhcH0uZxdddD3fWerrbZ6b+LEiXdIupK7zdFVhImIiNpWXIS7gLK1E5pNnc3Gxa6HDx+ObbbZJucKuqdSqdDy5cs7AUAikeAosiXaIaBqrUn+/N0myaXz3LJISgvdevE1nWEkDasOCjwJ4jUiTVY0SGDTATEoQlYAG0HSKOpCwM9+DKlk1CZNWB7/UZb9N1lcUxxJSkEopQIPav0gwmTREGRay/jPL59jdT+nK3z3qq4hJtgvnlWkbDDFEgpHFJFQ+mdqU4qkVYg46BRKwalbInV+yHiVi4+9Yfwxp7+p6k5YXWExoia0JqsHlpeXG9d17W677XbFjBkzdgRgc3XqIAD1fd906tSp6rDDDrtcRJbF43EGm4mIiNoIBrAoOwfqWTiFMBhMYIsttsCZZ57ZENDKjbgJ1FrrLl++fEtVDYOF3Fv0eLh+VaxzNCkbhyqhFhAxUKsQY+CKwqgHk/6HdJB1Pc6ldMjJafibwIMDH766CPt18B0Xc7QQodQyf241zKs/6ffVWw//k9dn79Nm1EQXGQisxDQ9tVGDVQo1XWS+icfYjacYGrPqa0g6wJeeXvlLLTuFAw8OLEJu+r+TFqjVEGKaRM/QMolqvS12/fwOld9d8U3irPKEiGVTpOakqkgmk795kpSXlzsVFRX+2LFjd/jyyy/P8zzPSu6mGqmqamFhYf3BBx980sUXX/xqUNie5yoREVEbwQBWK2GtlUyHNidG6FkYwGr8nvbcc0906tQJGgyCc2FgYK2V2traUgAs5N7ClwMpLKstKYjC1ZSI4wAQeH66WLtjAEfSGUXp6XYKtTaoDWUb2vIat/tg6qAGBdl9CFK+wBcPnitYWhNTp8axSKactxfLDws3P/DE26/487//dM4Vj7y1pNMzUxeGsDxVgDoNo14BKw7SVzMBmj0GGpyzK9fFUg0y1lb6bvVg4MN1HVgY2FQSSbiwAnSJVJr2EWv36Fgfjcz+7M8XXHzxrumZSQzkbsg+S67t79/6vKoqFRUVmDJlSumLL7741+XLlzu53CZFxIqI6d+//x133XXX457nOQxeERERtbHOIHcBZWlHNCsDQ5mBf+fOndGvX7+1Dga0Zr7vo6qqqj2AKFtoCzZB4+g3te2ql9Zbbyny4cGBUQsfDlQtHAFcE0wbDLKNbBDAysx4W9tAuChg1cID4MOB58SQQggza6JanRKpSSbN2zXdp3Q98IQj/nJFfNKgQYNcATy3106vVcc6LvQUsjgpusw3qAfgB0NKaaYZeKsq5L7CjS+4tlibqaMlsGKgIhD4EJuCEYFjFBaKWjcfdXBhxJqCsPErF8zuN+/rz46ORCLg1CRqJhqcu6u9EQ4ePNgREX/s2LHnzZw5cycR8VXVycWdZYyxqmo22WSTLx999NErrLUmHo/z3CQiImpr93zuAsrOUbpk7ftSVTiOg2233Tanjom1FlVVVf2mTZu2EVtoy4jH4wK1+K6+YH6V78ybV+ugNiUqolDjwAbT9EQ0HYBxzFpmM6483ktPp1MofDWwCvhOBJVJxbzKsK2pC0udg59+6rDFDVXbHnLy0Uef/p84YAYPHmwhogN32++NWFHha7CVqPehvrhIWoWnFgILB02fHJEJXmWSvFb1CVUVjkmvSKhq06s3wkkXercKKwJHUgi5FmoU870QfrLttLouqe/8WOUsQvF3O26/9TP1ySRUWQeLmvW6q6u5FphJkyZ5991331bffPPNScHUwZzs04mIWmuluLhYDjnkkMt79uy5tLy8XJh9RURE1PYwgNV6jpPJBFCo5fm+jy222AKRSCQnirmLCHzfx5IlS2I//PBDAQBMmDCBjbGFdBqw6xzklS5XE0OlRpBy0wXWLQT1qqi3Fn6QcSUi6RUAgxl7FqtPSkgXaLewQHoKXTofCXVQqBXAxLC4XrVKQ/7PdWqm1OV9VrPFyBP2u/ypS087bdz7CkgCsJmB48DdBs33w+3fqEslq8vyrHRwkxoRD0kThgeBEb/Z2quIwAS1rhp/ZG3ItLJwjIUxgGMMXBW4qnCNA8cNw3WAWs9iVjKmi1IRm7JGZqUK5b3qzs8W7PKn48ZedM1Laq0EixwSNTlVRSgUyl/560FdJ33yySc3vuaaax5buHBhe2NMQ6mBXBL0iTQajWL33Xf/8w033PA8AFNRUcHgFRERURsNjBBlZac0m7OwjDHo2bMn2rdvn1ODqerq6ujixYtjbKEtY8KECQoAff5U/r1p1+nNpImoKhBSD6J+w0U9k4Wkmal6QTqSqqYzkFZ3jOFA4SC9vJ4FkIKPdIqRK4pl9Y6tRwT/XWScF34ueG/uxjsfN+jky18Vkfp0ValfXloBUevhexQv/LkunHRNCK4AYgGoAysh6Aa8BUmjd6ZqYX0fjgIR4yAiQBgpAIKIscizdVjkF2GO39UWOWEpSFWZz35O1X0T63fLjU++8afzzz/7vczAma2Smou1FuFweCMAqKioaPh6IpEQx3H0jjvuGDdt2rQtg6mDudqf81XV9OzZ8/9eeumlq0QkFZyXPDeJiIjaIAawKCtlAliqmnWBrMwUwg4dOqCoqKjh/eYCz/Ocmpoaly20xc4LBSB7iKlCcfcPltWmaqBqHOurgcI1QEgMXHGgAvhq4VkLa4PAlUqwAt8qXx0WbjqApYDCwofAFR/WGv2hrp2trEuZWbUR/Nfv+o/ozscdetGVf/kiDjWqKwavghMFAFDTedNZ1YXd5vxcE5JKP6IQA9dPIuzVwvFTzXeeAvBXGsVKsDliEDIuXBgYTyFq4BiDfMeDb4H5qQJ4fsguT1rzybLYzzUlfW7QTXc9fYc/35cQkep4PG44QKYNca+prq7Oa3x/KS8vdwD4Z5999qAvvvhirLXWIl3cPhevh1ZVTYcOHRaMHj36olQqZcrLy3luEhERtWEciLaSfmymQ8ZVCLNnYBGJRBAOh3PleIiqwvM8U1dXx+tGC4rH45JIJNSWbDTT95Oz4YY28yQcrD4oMLAwklkxEIAqrCicoDyOQmBV4TQqEqVBBCrzd1VBSh34oQgWp0SrkpCIC5lS32Hu7MI+D17xj4evEJHazBL1CVn1OQxATjzxnM/e+/vSa+Xr524J25pS44jWS1jqTT4KjYcI6tCUZaQy1w0bZJtJ8DUTfL2h5roI1KanFBq1gCjmawkqPdhIyBVV13w2v/aHqbHu19w+oeKfuzhunV5+O1RVRITTk1qA53k5M0UuqOuEmpqagszDnEzbU9W8zTbb7MZFixYVBP+di1MHVVURi8Vk//33P/fyyy+fXl5e7lRUVPg8U4iIiNouZmC1kr5aprZFrmT6GGOyvq5UXV0dUqlUw6A/F/i+b3zfd3hKtrzCkvaLSmL4Kekr6mzIAoBRhaMIaj8FxZnEgRgTZGA1bqtB8ArpLMf0SoUpqHiAEagTwfKka5fUAstSmqyKlT0e2+3Ywwbc8PDljYNXv/EWNcigtHW9d3yz2kQ+knBUYEStTaUzw1ZXab0JaJBulRnaZ7Kv0lErH6qALwJrgKQR/JzK0wVeTCPRqJm/bLm8vyj8bvHQUw+98+Gn7xWROrV+EAvjqoMteF/IqX2vqqitrW2ogTV69GjjOI7usMMO1//444/b5/jUQWuMMTvssMP/PfTQQ/9UVfPEE08wsExERNTW+4PcBa1GTj1hNcZkfQbW4sWLUVlZ+csByoHgouM41nEcPuFuQZk6WNP99nXLbMivrPMxty4sKiYo9KQNl3dBOiPLgfz6AhJEeNQH1CrEpNcEDKuiRsJYUO/YOct88/USXZ4s3iQuR/3rjAOPHPv2HiJ1qrpWK3x13/PAyvfnOzUza8JImaiEXBfFdjGitjo9zU9/ed9NlY0lUIhYSLoaFxTplQ9NZgqlbwFNIWmARfWFWuXHpHL5clmUNB8s7jjwz7Vb7PvnY04cO1mtb4IMF9bVaWHhcNjPtQBio8LspqKiwh8xYsSwKVOmnOZ5ngWQcw8TghqUVlWdXr16zbr11lvjImLj8TgYXCYiIsqBOAF3QSs5UDn25DnbpxACwOzZs7FkyZL0oDsomt1WafDhYrFYsri4uJ5nZMubXLBr9WfzpSYpYSxDgfgKWAF8UVgBPKuwPuCqhRGFEWmYTidiYKGwANQ46Q0KxzhYoAVYUhvyK/2IeWueLJuU6pMYcuVLN23ft2hhPA6DtchCytTs6gNUdtxih9dSPmrqapLiI6YwYXhOGDaTKRb8v9X0tlL7W4ebm6Sz0SBwglUYgXS9qzonDDFAUl2dl4xZX0IyY7mkPlma/+jCHc48ab/EE9ecfu4lk4JaV5YD45a/BGXug7l2LGKxWG3wV//yyy/v8957791eW1urmWndudgXUlXp2LHj4oMPPvjCgQMHfru2AXUiIiJqvVjLhrJKJmjlOE5DEfcs7UTj66+/RnV1NYLly3Pi2ITDYa9du3YMYGWBYYOLk//5v9Il4i5BxEnXc8oEqXxVeOrDAnCNA9GGGjoQMTBGIfBgIUAQwIK6WF6rdpEJG+ulnHd+ql2S2vqAk++76i8V9zwu61z7KZhGqFOm/PhM8pHP9zLJ+oMj3jI1joj1Naj1LjBBgClTt2r9Qx4GCDLPRNN5XdYCniMALH4yMXVTeRJTlZd++lm/df9w71//71/niUg1cAQAcFBMLUZVJRQKIS8v71vf9yUcDttnn3324vnz53c3xvjW2pycym2t1XA4bHbbbbczrr/++kdV1RERZgUTERHlCGZgUdYGS7KZ7/v47LPP0ieRafunUWY1yIKCgiQDWC1+bqgCsh1Q23PAzv92YoWLHPVF1FEnqPSkAogDwBj4auBZgbUARGDEwIEipIBjAVEH9UmDect9Oz9pTDSV8maGO01cvPVh5ycS1z9tfU+C4JWu6/sFgP5b9/65umDjl6rdvNr8EIw6rloF/CADSyFQTQfhzErn/7pcD1QUanyIpGA1haT14BmgFj5qamJatdyRBbVe/WK30z8Xd9vjwgEHHXejiFRrOusK4HTBrGz7OfJRFYAJh8NaWlr6g4jo+PHjd5g2bdrBqmpzre5V5vw3xlgAZrPNNnv+ySeffCzYDwwyExER5RAGsCgrOU52PlzOBHKWLFmC77//HgByIvsqc0yKi4uX9ejRYznwSy0mapGGCBHRrrsc9qGo/QKpWqgYayFQTWczOcbANZKu3A6FMUDICBwo4AO+ZwCJoDoVwvzasF2GYlONdtOXd9n6ovYjrz3xigmXPhBkNqz3tK14PG5gfXy8wFn4vznVy+oQhi8h9VSCLDADBNOGMzWrGp9z6zL+V1h46sFTC88IUm4ESzVsf9YOXjWKZHlt6It5JZufmxpxzbmJvz52/QmHHPiDqoow6yp7Oyw5MpU+E7BxXdfbY489Fqlq8RNPPHHv0qVLC4Opg5KDx95aa02nTp0WXHnllWeLiMbj8fTJTkRERDmDUwgpa4MlmcFrNmVjZd7PnDlzMG/evFwbQCA/P/+/Xbt2nc8W2uIjXADA4q37LCz8V/SDZMob4sfEZMo9q2+DpxMGAgsHgCMGJihkbo3Ac0OoSqpWaUgXaMTMqsSHWwwaftH2x/757XWZKrgm6rruNMev/2HZvLpFnQrCBvAUritQGCj8RisF/vq8azyw/z3WKjwYWA1BHBdJNVhS76h180xltZh/z106d+Pdyy886swJrzQE59Yjy4yoie8zAkBramrcZ5999py77767w8yZM7fK1JTLvcudqKpqYWGhv/vuu99w0EEHfb8Gq6ASERFRWxyTche0nj5tTjXMLJuW90v9oPTYYeLEiVi6dClEpM1nYDWuS5aXl7ccQJKnYwsfk+B6cCeQyst3Fzqu2KW+iBUDV324RhASBzAOUo5ByCYR9ZMwamFMPZLi4Of6fF2YDGPqMms+ril5xe+/13F/OO6yt4LBYpMOkjPZesPPPfWLTr22/KdxjO/7nviaLiTvWQsLwKqkpxTq2iyMYKFSB5gkFD58CDy4sMHKiss1gtmpQju/3pHqVOrrZdFOD9VvPuTio86cMHGFz9oMwavgtQ3vtU3R5HPvM6dSKXnppZeO/vjjj/e31iqAnCvcHtx/1HVdZ4cddrjomWeeucFa6zB4RURElJvYqaasDppk0/vJBKq+//573HXXXVmXHdZcghUIDQCbl5c3DUAt1mIlOmqm4wJIhRh/Sk3eglQ4Mq/eN6j3HZse7QvECCI2ibCXwjInH8vcEKzroMq2w6KasM2TpCxIRe3L80s+S21/1NnHnXvNN+XlhzhogimDqzh/NB6Pm/4iSWeTrZ5NSeyriGMk4hgLa6HqAzYdpVDVoJT7mu0FhQv47QAvD651EPE95CGJqPGx2EZ1RqrAX15XZypN3luVfQ8Y0/eGZ8ddce2dDwbTI5utHcfjcSMiaoyxzZXRllvNPTvvDc3N932LdJ2nnFx1UER8a63p3Lnz26+99trN9fX1RlV5PhEREeUoBrAoK2VrDSwRwUsvvYRp06bBdV3kwoAi8xld1/Wj0ej0IBghbKVN06Qa7ee12qcTgkSsKf4mtqbeiygEteqIb1z4qlDfwodAHYOI9WBtFAtSRfpzbdQa1zHLJbZ8UccBV3Yefv5xF4898ut4PG4qKiqabTWvTBaWdt1s3uT5/vQaHygMAyGxcAVwoBD1YaDpAJz8elPBr7ZgmA/PeqgFUB2JYb4T05mpqNbYkHw/t9J5eXbeh1sc/5fj9jj5qnc3FVlmbWayZbNltppEImFnz57dYffdd7912LBhl6iqExxvnjvrfl+wORg4z9kMPhFRa60pLS1dcsopp5wpIn55eTkfnhAREeUwBrBa4UA3RzquWfV+MtlWtbW1ePrppxu+lgsBrEZTCOuLiop+4qnYtE0rEonAcZy1X2Etnv6jqHOP+YURpwoi8DRd5UqNARzANS5iEoY4Hhak6nR+bUpS1bVmmZZ8NK/HgScPnnD/DZedMOwLEcGGmpLTZZe9ly8t6DGzRqJQ9UQEcEQgEuRdiWmo8bXiOQiomvQ0Qx/wLaDqwIpFnVShHnXwXAdLkkYX1ISl0kZlti1a9l2k9zMFQ0+5uOfAXabH4zCZ+kLN8dni6RUMJRwO20svvXS/vfba69m33377jDfffPPK44477lAAWl5ezvvuOmoUeKTcuO/YaDSKwYMHX3XJJZd8AcBpziA7ERERZT92pCkrZVsGViZQdc0112DSpEkwxsD3c6sf7bpuTbdu3RawdTZJexIAcscdd3Tba6+97j/11FMvmjp1asdG//a7JkxIN8rNdhr2hbbb+H1jDFzxrfV9WLWwIrDioQqCn1Oltt4vwvJ6qZ5XvOk9dbscfcLQM656vLNIdRB0afZIrIioAtJTpK7LgKEVfrjgm5RVAcRCDKwY+CrwFNBVxus1CBojvWIhBNb6SHpAnVcIOCWoq3FszVIrXl20ribc/bFlvfc64aArnz7pktOOfTMeV5NIoNkyeMrLy51EImFjsZgeeuih59x1113PfP3117sASFVWVuprr732Z1WNVlRU+Lm4ilyTdFhyZBVCAkTEqqqzzTbbvPnkk0/+3VrLqYNERETEABZlp1AolBnot/h78X0fxhi8++67uOWWW9p80fZVRg7SA4pFo0aNWp4OnkzgQHI9jB492hhj9IUXXjj55ZdfPu699947TlW7Bvt2jYIbmUDMiB26L6xpP+C56qQsdazneNZXWB9Qi0rfQY1GrK8h8+FPFp+ket606fX/PvePB584xfqeqKq0RDHkP4w59T/qRJ+uTgF++n3A8yzqPIuUlV8FsCT4PzUCKwYKhaeAFQeuMQi5Ia3yrP+zxMwH1eHl/y3oefWg61447bDTLn1y+66yEIAkEmiWz5kp1F5RUeHfeeedvXr27Pn0k08+eePChQvDxhgLICQiOnfu3C12222321W1VNLV4xnEWrfABndC2z/Gaq01nTp1WjJq1KjrRKRKVZVTB4mIiIgBrFYWRMiZhhmsQthSg5XM9EDf9+E4Dr799luMHz8elZWVMMbkWhBLAcBxnLmhUKgaLOC+XjK1pi655JI/TJ48+WTf9+2iRYsic+fOrV+HdipqfdR32PyrsijmFDhJ1Ll5mnQiqEw66vn5vldTb95bZJd/V9xv3AX3PZfYTGR5PB430gzF2n93YBq0pR5AfW20/bR6idXluSKuWLUQ1MJBMijirhBYBawqbDrtCkYBzw9jeb2LpFqoY7DUD+msGpUvlrrOx1VFM71Ndj7x+BueuEZElqiqNOeUwcy5EIlE7NixY/e75ppr/v3VV1+NrKmp0cwg3FoLVTW+79uPP/74hBEjRpxljLFrGqikFQMbuVjIPMfu/aqqWlhYmBw9evRJF1xwwauZBRG4d4iIiIgBLMrOiEkwSGnJwYq1Fo7jYNq0aTjhhBPw6aefwnEc5OoAqrS0dBavG+s/Bk8kEhqLxfD444/fsGDBgg4AZMmSJZ1feOGF4rV9sUwQxHGdypSDOWHUIeW7mJ0s1pQTEXWjzmsL2i3+tnTAFbc/9PRtwbScJsu6ykyFXJufiQNGRPSDpQXL3/9Z6hZrAaoQhedEABg4UKQreVmoACkL1PlAUtPTdm2yFjAGjhvCwuqUXVxlxfcjdf+rKv1iZrsdLzz16nsrRMRXVWnGIJ2Ul5c7IqJTp07dePDgwTc//vjjL8yaNauviPiryrASEamvr7eTJ08+6oMPPuiUSCQ0mL5JaxHcQI49zMlB1hhj+vbte+8dd9zxpKo6LZElSkRERFnaH+QuoKwc5QeZVxsqAyuTcaWqsNZCROA4Dt544w2MGDEC7733HhzHQZBNkVPHQlUlEomgY8eO73ieh0GDBjFzZB2bNQCjqth2221vmj59+qBgipmtq6sLffnll9sAQCKRWOvrcn20Xc2nVdFl3yTbw3OKbMx6UpXCzBmxro/FBp9w5Hk33Xenl6oXbdrsuUxWxFoWn09Xn0912n5GqrjnvCU1KdSnfIWma7erOFARKAALA08c1FmDKl+wwDGojzmIuj4WJGP+3Lr2ptqUfY4+Q8bufdJFh15z/fUVUGuCRReas1A7Kioq/AsvvHCPfffd9+3XX399/NKlS01wPJ3VX9ZE582b1+OUU0652hijiUSC59La3ReUUwjbcIfUGGutNd27d//6rrvuivu+b+LxOAOWRERE9Et/gbugdcQQcu0Dh8PhTPCk+XZqo6BVMDiCiMAYg2nTpuHyyy/Hn/70J/zvf/9rKNqea8GrIAhgYrFYaq+99voZAAYPHsyn4et+vfWPPPLIEz7//POzU6mUVVUjIkilUli4cOEA13UBrHmtpkwtsnZbHVA/B6VY6oUwZ/FS9+u6wre8LQ86uue4J0879uSTX+oqUgNApemuJQaAVdUCVY0iHZyTtXnPW5899ou+m27yf2EHqZBNQlO1gBjUqYt638AaA2tcWBNCnRXUJBV5GoabCtsfaorsx/N950dTOjk8aOxxO53z14d22HO/b0XEA5qvUDsAk0gkrKqGRo4cedJ999330A8//NDT931rjNGg0PQqrxPB14zv+/bbb789auzYsfsaY3ysPuBFvw5wMAOrDR9ba60UFRXJXnvtdf3222+/sLy8XJh9RURERCsPQij7NXTacyWAEo1GYa2F7/vNsq2cSZVKpbBkyRLMnz8fH3zwAU477TTE43H8/PPPcF03Fwu3A/glA66oqGjxDjvsUAUAiUSCA8i1FGTt2Mcee2yzt99++7Lq6mo1xiDIFBJVRU1NzVapVCqCdABL1ub47Nody2YswILPZy3HJ1V5b3yz6egztz3hykmbFMsSXYvg0hp+DgPA3n777dtsueWWbwwZMuRK13XXuDaRiGg8DrO/SH1+h24VXqzD1ymETEphoYBVQZ1vUecL6q2i3vMBEUSiMU3WGNTWu2ZhMizv1ZR9OPePx47dcfSRn1vfk+acjpf53I7j2IcffnjAtttu+38vv/zy3fPnz+8mIhaAsdb+7j5WVTHGSHV1tfvkk08+esEFF4wC4PNeTDnfyVG10WhUBg8efP4999zzKACnoqKCwSsiIiKiVtShk+DP9nvttdeLSAexfPwS0Gpzm+u6CkBPPvlk3VCWLl2qr776qh5++OG65ZZbamlpacN7McZoo2lSObcFGS26zTbbvKCqITRhMCSHCNJZbNhyyy1fAKDGGC/TroIAiHbu3HnJAw88sGejgMkaM8bBjZdfeexZxx1+9fOvvd8VSNeaasqV7jLvKRqN4tRTTz22U6dOPwPQ7t27T1PVkrV535n39fWrr3a540/bvfzF2X3twos396eP76Pfn72p/nheH/3h7E31+7N66Izxm+r0iwb6X5+9ub5xci/v9fN2//qpK0+76IWJ7/QSETR3Hany8nIHSK+Mevjhh5/auXPnRZlrcZBBtbbnlGZ+rm/fvl+oajEArkr4++cQbr311kPLysqqG5833Fr9PUZFxBMR3Xzzzf8RZKHy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fCKROPrcc899Jx6Pm08++STFPfR7u09EVcO77rrr36ZPn75DUPeKWWvU9m4e6amEunDhwo3uvvvuayKRiFZUVPhgkevWcKHCKmqWaTweVxHxjzjiiItLS0uX+r5vWnNts6bu16qq/+WXXx569NFHHwTAjh49mn1dIiIiog0w8MhkibQfMmTIS2AGFp8upwcpPgBt37593eGHH366qhbwbFlz8XjciAjGjh17VF5engLganjc2nzGJgA/EonYAw88MK6qkWBqVWsJYuVkBlZeXp6OHDnyQGCFDCxk/tsYg/333//UaDRqmUG64iqcAOxGG20084477uiG1pl1SERERNR6A1h77rnnv4POGQNYudkhz0wFsuFwWHv37v3aeeedd6DrNiwkymyKNQxeAZDnnnuue/fu3acDsMFgh+2MW1sPZFkAtqioSE855ZQjVxUUyfYA1kUXXXRySUkJA1i/XPONqpoBAwa8Dk6DXrm9ewB04MCBD0YiEd4jiYiIiFoigMUMrJztiFsA2q5dOx08ePDVeXl5DQM71vdYYwLACYfDGDBgwGOZ84nZV9xyKBDuA7A9e/b85vXXX98UgLSSItc5GcBaTQ2sXwXk77zzzv5dunSZDsCyj/BLwFZE/Fgs5o0aNeoyVQ0D4CqcRERERBsigDV06FAGsHJwGkTmeOfl5el22233yvjx449W1ejqBjS0euXl5Y6IYPfddx8XjUZVRLxG06u4ccuV6YS+iOgf/vCHp6PRaGsJgnMVwtVc7zNfP/jgg0c0WpWQWaWNphIWFxfrRRddtCfvm0REREQbJoBVOnTo0BcYwMqpqT4+AI1EIrr55pu/cvjhhw9T1Uij5sGnyGshk2Vy1VVX9S8pKakGpw5yy+0glheLxezBBx/cWqYS5mQA6/cysBpxXNfFgAEDHjLGcCrhikEsD4D26tXrreDhj8MsLCIiIiIGsLg1wfLfmYFHJBLRsrKyZXvvvff1qmpWGsix873255F59913u/Tt2/ejYFDDqYPccjaAFUwl1I4dO/78/PPPd20c5M3mANbFF188prS0NJVLAazhw4cPX4MAlgCQpUuXlvTs2fO/YL3MXwVsQ6GQDh069GwRAQCXd0YiIqLWiUsLtw5irWXQoi0e2PRgUtNxFjUAnK5du87bZ599jrzuuut2nDRp0vkiYsvLyzNPjTODNlrz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AVdqa/ZrnjbX65aXl4uIVA4fPvyKkpKSlLUW4MOjhl1kjNHKykp9/vnnr5g2bVq7iooKMAuLiIioZXHgl90dVwBALBarttbWB5kmudEwcy/jjH5HsAS8HT169MHffPPNiCCDgCtEEW1AqupYa+2UKVNOOuiggw4AV2prti5A0A9otnthRUWFX15e7tx2220v7bjjjleGQiGDdCFzcDohYK01ImJnz57d7/jjjx8vIr5wxxAREbVsnIC7IKsHCgCA2traEgDtVJWdSspJ8XjcVFRU2JtuuqnXxIkT76qurnaRrknCnUO0ge9LIoKamhp9/fXXb3/44YfLKioqfK7U1jpVVFTYZDIpL7300tWdO3f+GIAJVjumoJ/seZ797LPPzhkzZsyfMtMLuVuIiIha6MbMXdBqjhM7TJSzEomEhMNhfeihhy6bP39+x2DVQZ4TRC0gmEpoFy5c2OOaa665WVWdRCIBnpOt83CWl5cbEfH222+/00tKSpZzVcIViOM4snz58oIXXnjhzieffHIzEVEGbImIiFoGb8CtpIPJKXWUq+LxuDHG+CNGjDjz+++/PxoApw4StfRNKX0O2mnTpv1p//33vzUSidjg680WxJK0nNnFQHoaW3P/ooqKCh+Ac88993y07bbb3uC6rqOqXJUw3Z7h+74A8OfMmVN08803XxiNRsGALRERUctgAKsVdqaIckU8HjeJRMK+/vrrPd55551Lq6urxRjDQQNRdtyLJJlM2rfffvuUk08+eU8AOmHCBNkAv5eafr9aa63517/+dftmm232QSZAyT3TwFFV+8UXXxwzYsSIcgC2vLycfWgiIqINjDff1kGstRy0U861+0QiIarqnnHGGbfNmzevgzHGWmtZ+4ooS85REUF1dbU8//zz18+bN68gOGeb5X6lqsL6Q812IDUej6OkpGTpqaeeenSHDh3mqarhVMJGHWZjUF1drW+99dYNzz777EYVFRWWUwmJiIg28P2Yu6D19C+DTib3BOWE4Om2P2zYsGOnTp16oKr61lrD4BVRdggKWhsR8WfMmLHtqFGjxgNo1pXaOJ2++SQSCVteXu6cfvrp3++www7nRaNRBcCphIHMqoTz5s3b5Lzzzrs9FAppMJWQiIiINhAGsIgo6wSrDvrXX3/91pMnT56QTCYtly8nyt6+hKraKVOmnHvyyScf0lwr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KOZlLkd6BqdsGymwAhGVevXqbb/88suHbNq0Kcvtdi/wer0IAMhRV0zQ+wl4CIIfRVGQW9YHJ9nZ2SSlxNmzZ7+enp6+/CRRWERE2Lhx49+eeOKJ+bz+gvaAB0REXdehsLAwfsmSJbZwsOWg1JkiNF1Xvv766xV79+69pWvXru2TkpJejIqKylUURTH2GQlGSpyRGiD//vvvBh999NHozp07T33sscd+XLlyZTczUisCXB4AQMb4kQTQBSKoUVFRB9PS0t7u27dvh7179177008//WE4PLlTDxN0RovL5UJEzL3vvvuurlWrVo6RRhwRMsrpzsxpGvcopURFUbBOnTprW7Zs+ca11157xR9//DHM7Xb/hYi6sc9rEWzol12OIWLh+PHjp2zduvWiLl26PJqamrqXiEQERaWFlGwjoqhTp87fnTp1etPlcl3h8XgmImKJ4YwNh8YDTATABnQIYN4cRsypGELKJiKS0+kUiHikRYsWrzgcDjQiU8o7RIiIsHbt2nuuueaaZ4uLi9HlcoVsLZJIMAiMKCRf586d/WH0WNJQOoWu68rPP/+89sCBAw/369evbf369f8vISFhk6qqAv5NL9TNVuE5OTn2P/744/w9e/bUDPcWhGanRkSQiKADEAJIRVGESEhI2FKnTp2n+/bt237Pnj33fP311yuMWmmm4yrkFHbuqhb+mKmE995778ZzzjnnSavViuGeShj4bBXcGIYXS9js8aXdBBFRN5qciNjYWL1u3bq5l19++Xs7duzovmbNmmFvv/329JKSEjSMfHbMHL0W0Ol0KoiY/9tvv41++umns1q2bPljfHy8z7wUM5vHcEphlct4meMKAERSUpKvW7dun+3YseP8P//8877bbrtthanvcdQVE0qwAysE8Hq9odgN7cwtbCnB7/crofJ9PR6PBAD84YcfJjZv3vwHABDHiMIiVVUxMzPzuREjRixwOp2CD4sg1cZKI4+kEAIcDscCADhozGk4GS1ljiwiUj0ez65NmzY9++mnn7Zp2bLloJo1a35rs9mKAECRUgopJQohNEVRNKOLWdjuR8ba1UpFoTTM3m63e2vWrPljZmamc+LEia23bdvmmjp16jYppRlxxQXaQwRd1zGUzpdKOKuUGTNmjG/ZsuUXiqIoRjRJJMx7hem7qqqaZwFb46G5x5tGPREREpGiKIqSnp6+/8ILL3TfdNNNvV588cULp06d+hAiHpRSqk6nUwEAMvQ2dmCWU5s8Ho9Zc1MdOnTo+tWrV182bNiwbu3atZsUFRUlpJRHpRayI6vKZByJSMTHx1PPnj3fGjFiRI958+YNRcQ8XdeVgFpXLNNMSMFVLUMAIQRGkgPLDN8Opa9s3D75Xnjhhae3bdvW5+DBg6oZdYWIUkopUlJS9t59991TZs+ejZmZmXxYBP+6g/37928xHFdKmDooTMcLAoC44oorigDga1VVv+7Vq1fDdevWDc7Pzx9cVFTU3u/3q7peZuuavxFhYMSRMQYEAGppW3AUFosNbDbrqoSEhMkNGjT4cuHChRv2798Pffv2Nc9OCWFS5FTTtIjZj3Rdj2TLiQCAEFHOnDlz5M0339xr9+7daWZNlHC04wBKL8UqWodiAzz0DHowyjiYL6vVCklJSTtiYmL+TE9PX3n11Vd/e9999y2fMWMGvPnmmzBkyBAwdDjN4/HwIJ7a/qIZRd4lAPxBRNcPHjz4l1WrVl2yZ8+eCw8fPhxlzIcEDqKoTDkXRISJiYkFderUWZKVlTXp448/HvfLL7/A448/bsq17na7edCYkIQdWCGA3+/HCFaWQsKw8ng8usvlEo888sjSWbNmffjrr7/epWkaISIQETgcDurevftjTqdzj8vlCuXoq7JC9eGecqTrOkRFRdURQoCUkiJgnenG/ApN02jWrFlbAGC01Wod3bp968452/f0zy8suKykpKSN5vcr+r9DYhawNWv1BfVmZTiWzZbfaBRcVwQiWKwWsNnsa2Jjo6enpaV/88cffywSQsjt27cD/OusMyO0woa6desmCiEi5pBRFCWSLxCky+USffr02X3rrbfe5fF4JuXn56tGh9xwSyUlMPoTVGQXQsPhx8pp8O3tpZNeur+X1fIxo1AAAB0OBzgcjgNJSUl/9+zZc+FNN9007oILLti8efNmmDdvHgCAcDqdmJmZSdnZ2cSFyE8fU781HFl+AHjXZrO9e/fdd/ebNm3aM3v37m1dWFiomHoHIpop+Fyv7gzlPiCiUEFEjIuL09PT0zcNGTLkoaeeeuonM9LW6XQqHo+HC+wzDFN5GKGdMHny5EY1a9bcD8bNKfxbZC+sXkZqEmVkZBS+9dZbtwU6TEJCUzZueIkoKSMjYxmUFs3xAQA1atRooWEoh2LECgIAPPfcc8mJiYl7wl0OjefTEJE6d+78qqIoAKURWJGGgHKXHEQkOnTo0LlBg3r/FxcXN9thdxSoqhpoLJiOML/h5NGreS7NKCkt4DuZc0wWi4XsdntxbGzsvLp167o7d+7c1VAAAx9bhTC9KTbPmOeff75nfHy8F46ORgu3Na0DAJ133nkbfv755y6Bzx+hqIgI55577pMWi6VszwuzeZcAQDExMTR06NBupgF3pgNm/t8+ffrcarPZKAj2t4h+mWlSAS+9/P6FiGSz2Sg9PX1f9+7dv7zmmmuu/OCDD+oTkWLoZOZZp0T4flCZ+qMS4KCKuf/++7t06NDh49jYWDI6jhMimnWyJMv2Kcu/NOu3mbIeHx+v9+zZ86NHHnmk58KFC9PL6XMMEz4KDA9B8BMdHR1p9VVIVVVfyJ3SpQXdFUQ8eMkll3yybdu2dn6/H6Kjo6lTp06vIaJu3n6E4qQ4HA79BB0Ww9ODI4QfIpfAfccs6q4BwBIAWKKq6jNXXnll3cWLF5/r9Xp7FRQUdPT5fK2llDa/3y9O8FkY4MTFCnDoBnbNCfy9KO8wVlUVFEXxWa3W1dHR0cujo6NndenSZdGkSZO25efnw44dO8xbfDXAANbCfaKNRiERoeAqiqJFRUVpEOEQkY6IysKFC0c3a9asy/r16/sJIcIqldCMFEZEabFYdACACkrf1ziFsOr1K/g3osqU4fLnB1qtVoiJifFGRUXtiY6O3mS321ekp6evve6663679tpr1yEiffnll3D77bcHOlgkAACnU1XOVgMBJQcQsQAAFtvt9sVXXXXVN2vWrOl14MCB3nv37m0Z0LBKCiFCrZRIla8FM6pQVVVIT09fU6NGjd86deo079NPP/1i7ty5MHr0aIDSKHOINN2dCX/YgRUCbNiwwa5pms0wpAgNKiLU1tjYTuv9x1MUA//9VD8z8Ocbv1JeXp5t3bp1LYjIiog+I1c7JMJdJ02aJBER77rrrq/+/vvve7Zu3ZpRv379uV999dXXEydOxMmTJ4dczRyXy4Vut5tyc3OTdV13AIAuhCCzlkz5uT6ZXJ6KbAR+xtkaCieS8fLfNeB9OgBAfn5+kimXEb4N6QHKvplmqE+cOHEHAOxAxEkWiwU6depUryg/v+O2ndsziSDL6/XWJSkz/JomiEAE1NAKHHNpzEWgEwqOJ1vm3hewBwow0oTMjxCKAkgEFouFhKJsstms24VQ5tdJS1sbl5j4x+LFi7cUFBQAEcGmTZvM5zJTGiLCaQUAsHbtWgQA2LZtW5KmaWhE4fynXtDJ9v0zOSuq0FFj/kwJALRv377Y9evXx7MRhORyuQgRfR9++OGwxx577Lx9+/YlCCG0M6kXdaZ7dkXu9cd6RrOmZlFRkTVQ5s8Ej8cDRkp5mt/vD4wWqXCZPRU9q7rXVkXqlsf4/xRw3mB5Z5WqqmC1WkFVVb+qqgdUVdVr1Kjhbdeu3cxzzjlnZs+ePf/s2bPnjpKSElixYgVMnz4drrvuOnA6nUpmZia53e7/nDdMpSMBAE2dcsKECd8IIb7RdT1h0KBBo5YvX35ZXl5eclFRUazf7wdD1zTPo4hNMTTSu00HLpbW6RQYExOjx8bG7mjbtu2UH3744RmLxXJo6dKlAACBci7Z2c6wA4upFhwOh2a1Wq1CCNXYzM2ipJWqLJ3NZ5zOZ5rvNY1bTdOgqKioBgBYACCkIrEMo0D0798/Z/DgwW6LxfJCVlbW84joM2pfhezpm5CQYFNVNQ5KO9OdsfxU9vvP5jMC3qcAAPj9/lp8+B89RAFOHtN5JIiIfD6f/ttvv20HgO2IOBURntF1aWnTvHmjuBo16m3btq1dXl5ejYSEhLY5OTl1EDHKZrPVLikpsUgpwdzbjjVnRARCCBBClP2ZiEBRFHA4HH4p5T6v15ufkpKyJz8/f3lsfHxuzeTkxeT17lr5zz/bhBAlAAAHDhwIfBYF/r19jxin1XH2LVUIoZjjWplrs6oNkADHpoKI4PP5knfv3p3ES7m0Vo3T6VTuuOOOzU6n89EZM2aMO3To0FnrhWc6xxUtG+WcY7aK+lyr1WpRFEXRdV2pynqQJ/s5wWbcn+n3CaxZRkRgtVohMTHxSHJy8q7o6Oi98fHxu2NiYjapqrq2fv36O5o1a7ahdu3aakxMTFK3bt02IWJJuX0eXC4Xud1us1seU41iYerBRkYCIuIhIhqxcuXK0XPnzo378ccfncuWLRuWl5eXpGmaKUckhKCACxYMRpmvSFsCSgMWQEpZFklusVigRo0aR5o3bz61ZcuW40eOHLk6IyMjz9BTzZRYneWcCXu9lYcg+FEUBa644grnmjVrWmiaBrquKzExMQlCCHtA3aXTOkCMvHOQUpaF6ZrGofF5x5KN8iG9ZgQOljNwTcPW/KzydZ8w4NnM3HciItVmsxU1a9Zs0eDBg3/p37//llBeW0II+uWXX9J69eq1J9DhE7JaB5EYOHDgbVu2bGmtKIrF6/VajdbI5ee3bO6P89yn25TgdN5Mx/hh8mTvMdeEEMKURUVVVXuzZs3GTZw48eennnoqlAvvVyXCCYCeox1DRxkmiqKAruvw888/2999992G06dPT8jPz1c6d+6cJqVM37NnT428vLwYr9erSCkFEaGiKNJms/nj4uKK0tLScq1W656lS5fucDgc8tJLLz304IMP7uratesRVVVBSnksuRPGdyPP0XUkItuSMKJbN23aFH/XXXfdl5OT00JK6QMAoeu6ap4rp7J/mYsaEclwSMqAfQAD3nbGekdgGhH8WzsRAm6ny+reGOtZVxRFM842KyLmdOjQ4a8hQ4bM7dWrV24oRfdW9rq1Wq1y4MCBg9avX3+JpmmKpmkQODaBURCBUxKgKxxrXkX5dXayFEXzZxqG239SjI3IS7Mod2AEp/lnUhTFrIlEUkp7rVq1tj7++ONPX3TRRYfPZs7NBizjxo2rN378+Pv8fn8yIhaXlJTYdV23IKIwjM1TPc/oNGX/qIVYTnejcv8mjnPgYnn9rLy+pygKBeqGJ/teAVHK+O/H0rHO+kB5ArP+kbFf6Ma61RVFKSwpKdkZFxdXnJaWViM5OZnatm27tG/fvutbtGixBwDyVVX1HSui15Q7o5A78D4fOudQ2eQJAa+88kq7r776qsfBgwc7lJSUdNm3b1/T4uLio0TcjM4Khy7tAWmB5hote6aEhAQ9Li7ur8TExLU1a9ZcdvHFF6968skn5wSMhxmVzrLOsAOLCXJtMyAaIcg35dP+P0boMBMishduEUqBqQ8sixVyxmA5hUyvRKPCTAUE+G/RU+YkWCyWs079qe61e7y/Q0TQdZ27XJ0EVVVP2GU2WGTjRGULyqclapoGFX2JZEYJnW7ZhHDQ0SpzvQKUOsxN55TRRAWO4aw6qlsgAEB2djZy58DQ1RWICLKzs9GoRSbNM8nn89UYOnTozXPnzr0sLy+vidfrTfV6vYrP5zNlWBrpwmUO7sDPDLb1FtgsI6CeW1lziaioKLDb7fk2m21b48aNN/Xu3Xt6dnb2Zzabrdh8ZoBShzrLO8MwQY3R/UYNeClB9BIV+XI6nUo43KiYB0yYiWKlzHmQv5hK0uWM9RG4l6in+Cr7P8Zn8GXMWc5FmK3r451TSjidL5WkZyjHGMdwkIkKm3NDfiLtHKzq9Wvu9ebcCZfLJcIl4oY5Jd25rAOwUS4AZsyYkfLggw92HTBgwEOdOnX6uWbNmoVGF9VjderTzS59gd0qofI77UoAOKo7ptEp8D9dS42IUYqLi9ObNGmy7YILLphw/fXXX/fiiy9mEpGNiITpxIWju2XyGmAiXmllGIZhGIZhGIZhmKDBSDEE+G86csIbb7zRc86cOXW3b99er6CgoInf72/s9XpTCwoKkgsLC8UJIi/Nzwrsjlw+IhFP8P8CIwgp4P3H7ayMiBAdHQ1RUVGHHA5HjsPh2Gqz2dYnJyfvbN++/b6LL7547RVXXLGkqKjoePY6R1oxzAkWJ8MwDMMwDMMwDMMEhc0akGaI8G93ZEBEsFqtUFJSEjN58uRGK1eu7Lpy5cpemzZtqnf48OHYkpKSZE3ToqSUFilltK7rZamqZmr52TQdUBSl7Ffj5RdCFAshihwOx4G4uLi8Jk2a7MrMzFzavHnzhTfffPO66Ojo3JKSkmOlNytm0wHjz+y4Ypjy646HgGEYhmEYhmEYhgkFiAgDnFkA/6YGghACdF2PNv5M8+fPj1myZIk9JycnStO0hnl5ebE2m62J1+vtUVhY6CguLrYVFxc7vF6v1efzWb1er9Xv96u6rpvNIUBRFN1isWgWi0VTVdXvcDhKLBaLz2azeePj44sR8Z/i4uK/kpOTc+Pi4nJ1Xd9z3nnnFQ4aNKgASp1tFgAoLFezSvn3cbjxAMOcKuzAYhiGYRiGYRiGYUKWAKfWSZu32Gw2KCkpqZubmxu9a9cux9atW2MPHz7sOHTokP3AgQNRhw8ftgV287TZbFpMTIw3NjbWl5SUVFyzZs2ipKSkkvT09MJ69eoVAcBORDxp5x8uvs4wZw87sBiGYRiGYRiGYZiwoHyx/+zsbAQAWLt2LQIAeDyesoitCkRxOp2QmZlpdsY86vPZacUwFQM7sBiGYRiGYRiGYZiIwXRymc6tQExHl4nplCqP6aTi9D+GYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRjm/9uhoxIAQCCAYu+woP3T2EEQ/NgiDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOChqZYGAAAAAAAAAACAC1NtDQAAAAD86gBPJE7FoLmeFgAAAABJRU5ErkJggg==";

// Reusable Logo component. Three sizes are dialed in for the places it
// appears: hero (welcome / signin / dashboard top), header (persistent
// navigation bar), and auth (signin / signup forms).
function Logo({ size = 'header', onClick }) {
  // pickedHeight maps each size variant to a pixel height; width auto.
  const heights = { hero: 110, auth: 84, header: 38, headerMobile: 30 };
  const h = heights[size] || heights.header;
  const img = (
    <img
      src={LOGO_DATA_URL}
      alt='PakMondo'
      style={{ height: h, width: 'auto', display: 'block' }}
    />
  );
  if (onClick) {
    return (
      <button
        onClick={onClick}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
        aria-label='PakMondo home'
      >{img}</button>
    );
  }
  return img;
}


/* ============================================================
   I18N — translations dictionary and context
   ============================================================ */
const TRANSLATIONS = {
  en: {
    // Brand / generic
    "brand.tagline": "Be Prepared, Be Anywhere.",
    "brand.subline": "Inventory  /  Trip Planning  /  Provisioning",
    "brand.fieldTested": "Field-Tested",
    "footer.fieldEd": "FIELD ED. MMXXV",
    "footer.contact": "CONTACT: pakmondoapp@gmail.com",
    "common.back": "Back",
    "common.cancel": "Cancel",
    "common.add": "Add",
    "common.discard": "Discard",
    "common.save": "Save",
    "common.yes": "Yes",
    "common.no": "No",
    "common.done": "Done",
    "common.loading": "Breaking camp...",
    "common.loadingSub": "Loading field journal",

    "kitDetail.itemsInKit": "Items in this kit",
    "kitDetail.empty": "This kit is empty. Add items below.",
    "kitDetail.unlinkItem": "Remove from kit",
    "kitDetail.addExisting": "Add existing items",
    "kitDetail.tickToAdd": "Tap an item to add it to the kit",
    "kitDetail.noOthersToAdd": "No other items in your inventory to add.",
    "kitDetail.createNew": "Create a new item",

    "catDetail.itemsInCategory": "Items in this category",
    "catDetail.empty": "No items in this category yet.",
    "catDetail.unlinkItem": "Remove from category",
    "catDetail.looseItems": "Other items",
    "catDetail.notInKit": "not in any kit",
    "kitsView.categoryGroup": "CATEGORY",
    "kitsView.noCategory": "Uncategorized kits",
    "catDetail.addExisting": "Add existing items",
    "catDetail.tickToAdd": "Tap an item to move it into this category",
    "catDetail.noOthersToAdd": "All your items are already in this category.",
    "catDetail.createNew": "Create a new item",

    "itemDetail.category": "Category",
    "itemDetail.weight": "Weight",
    "itemDetail.quantity": "Quantity",
    "itemDetail.size": "Size",
    "itemDetail.consumable": "Consumable",
    "itemDetail.expiry": "Expires",
    "itemDetail.notes": "Notes",
    "itemDetail.edit": "Edit",
    "itemDetail.delete": "Delete from inventory",
    "itemDetail.confirmDelete": "Delete this item permanently? It will be removed from all kits and packlists.",

    "import.button": "Import",
    "import.heading": "Bulk Import",
    "import.title": "Import from spreadsheet",
    "import.intro": "Add items and categories in bulk from an Excel (.xlsx) or CSV file. The Items sheet has a Kit column — items sharing the same Kit name are grouped into a kit automatically. Existing entries are never overwritten.",
    "import.stepA": "Step 1 — get the template",
    "import.stepB": "Step 2 — upload your file",
    "import.templateHint": "Download a starter spreadsheet with example rows. Fill it in with your gear, save, then upload it back here.",
    "import.fileHint": "Upload your filled-in .xlsx or .csv file. We'll show a preview before saving anything.",
    "import.downloadTemplate": "Download template",
    "import.chooseFile": "Choose file",
    "import.loading": "Reading your file...",
    "import.parseError": "Couldn't read this file. Make sure it's a valid .xlsx or .csv.",
    "import.templateError": "Couldn't generate the template. Please try again.",
    "import.previewIntro": "Here's what will be imported. Review and confirm.",
    "import.warnings": "Warnings",
    "import.samplePreview": "Sample item names",
    "import.startOver": "Start over",
    "import.confirm": "Import everything",
    "import.successTitle": "Import complete",
    "import.summaryAdded": "Added {i} items, {k} kits, {c} categories.",
    "import.summarySkipped": "Skipped {i} duplicate items, {k} kits, {c} categories (already in inventory).",

    // Welcome
    "welcome.signIn": "Sign In",
    "welcome.createAccount": "Create Account",

    // Login
    "login.stamp": "Returning Member",
    "login.title": "Welcome back",
    "login.sub": "Resume the expedition.",
    "login.email": "Email",
    "login.password": "Password",
    "login.submit": "Enter Camp",
    "login.noAccount": "No account yet?",
    "login.forgotPassword": "Forgot password?",
    "fp.title": "Reset",
    "fp.title2": "password",
    "fp.sub": "We'll email you a link to set a new one.",
    "fp.emailLabel": "Email",
    "fp.emailPh": "explorer@pakmondo.co",
    "fp.send": "Send reset link",
    "fp.sent": "Check your inbox",
    "fp.sentSub": "If an account exists for that email, a reset link is on the way. The link expires in 1 hour.",
    "fp.backToLogin": "Back to sign in",
    "fp.newTitle": "Set a new",
    "fp.newTitle2": "password",
    "fp.newSub": "Enter a new password to finish resetting.",
    "fp.newPwLabel": "New password",
    "fp.newPwPh": "At least 6 characters",
    "fp.confirmPwLabel": "Confirm password",
    "fp.confirmPwPh": "Type it again",
    "fp.mismatch": "Passwords don't match",
    "fp.tooShort": "Password must be at least 6 characters",
    "fp.update": "Update password",
    "fp.updated": "Password updated. Sign in with your new password.",
    "fp.linkExpired": "This reset link has expired or is invalid. Request a new one.",

    // Signup
    "signup.stamp": "New Enrollment",
    "signup.title1": "Join the",
    "signup.title2": "expedition.",
    "signup.identity": "Identity",
    "signup.required": "Required",
    "signup.fullName": "Full Name",
    "signup.username": "Username",
    "signup.usernameHint": "Defaults to your first name. Must be unique.",
    "signup.usernamePh": "wayfarer",
    "signup.usernameTaken": "Already taken — try another",
    "signup.usernameInvalid": "Letters, numbers, dot, underscore, hyphen only",
    "signup.usernameAvailable": "Available",
    "signup.region": "Region",
    "signup.regionHint": "Where do you base your expeditions?",
    "signup.regionPlaceholder": "Select a region",
    "signup.passwordHint": "Min 8 characters",
    "signup.provisions": "Provisions",
    "signup.priceLabel": "$9 / mo",
    "signup.cardNumber": "Card Number",
    "signup.expiry": "Expiry",
    "signup.cvc": "CVC",
    "signup.fieldMembership": "Field Membership",
    "signup.submit": "Establish Camp",

    // Header
    "nav.camp": "Home",
    "nav.inventory": "Inventory",
    "nav.trips": "Trips",
    "nav.packlists": "Packlists",
    "nav.cart": "Cart",
    "nav.inbox": "Inbox",
    "nav.library": "Library",

    // === Sharing & Inbox ===
    "share.btn": "Share",

    // === Library / Publish ===
    "lib.publishBtn": "Publish to library",
    "lib.publishedBadge": "Published",
    "lib.pendingBadge": "Pending review",
    "lib.rejectedBadge": "Rejected",
    "lib.dialogTitle": "Publish to the community library",
    "lib.dialogSub": "Curated submissions appear in the public Library where any explorer can browse and import them.",
    "lib.fieldTitle": "Title",
    "lib.optionalSuffix": "(optional)",
    "lib.fieldTitleHint": "How should this appear in the library?",
    "lib.fieldActivity": "Activity",
    "lib.fieldActivityHint": "Pick the closest match, or type a new one.",
    "lib.activityPh": "Trekking, Camping, …",
    "lib.activityCustomLabel": "Use \"{name}\" as a new activity",
    "lib.fieldDescription": "Description",
    "lib.fieldDescriptionHint": "What is this for? When/where did you use it? Why is it useful?",
    "lib.descriptionPh": "Three weeks in the Cordillera Darwin range. Wet, cold, exposed.",
    "lib.submit": "Submit for review",
    "lib.submitting": "Submitting...",
    "lib.submitted": "Submitted! An admin will review it shortly.",
    "lib.cancel": "Cancel",
    "lib.titleRequired": "Title is required",
    "lib.activityRequired": "Activity is required",
    "lib.descriptionRequired": "A short description is required",

    // === My submissions (in Settings) ===
    "lib.mySubsTitle": "My library submissions",
    "admin.reviewBtn": "Review all submissions",
    "admin.reviewHeading": "ADMIN",
    "admin.reviewTitle": "Submission Review",
    "admin.reviewSub": "Review every submission across the community. Approve to publish, reject with a reason if it doesn't meet the bar.",
    "admin.empty": "No submissions in this status.",
    "admin.filter.pending": "Pending",
    "admin.filter.approved": "Approved",
    "admin.filter.rejected": "Rejected",
    "admin.filter.all": "All",
    "admin.currentStatus": "Status",
    "admin.rejectionReason": "Reason",
    "admin.itemsInKit": "Items in this kit",
    "admin.itemsInCategory": "Items in this category",
    "admin.kitsInTrip": "Kits in this trip",
    "admin.standaloneItems": "Standalone items",
    "admin.btnApprove": "Approve",
    "admin.btnReject": "Reject",
    "admin.confirmReject": "Confirm rejection",
    "admin.rejectingTitle": "Rejecting submission",
    "admin.rejectingHint": "Optional: tell the publisher what was wrong. They'll see this on their My Submissions page.",
    "admin.rejectReasonPh": "e.g. duplicate of existing item, missing details, off-topic...",
    "admin.noActivity": "no activity",
    "lib.mySubsEmpty": "You haven't published anything yet.",
    "lib.mySubsEmptyHint": "Publish a kit, category, or trip from its share menu.",
    "lib.subStatusPending": "PENDING REVIEW",
    "lib.subStatusApproved": "APPROVED",
    "lib.subStatusRejected": "REJECTED",
    "lib.subDelete": "Delete submission",
    "lib.subDeleteConfirm": "Delete this submission? It removes it from the library. Anyone who already imported a copy keeps theirs.",
    "lib.subDeleteYes": "Yes, delete",
    "lib.subRejectReason": "Reason: {r}",
    "lib.viewMySubs": "View my submissions",

    // === Library browse screen ===
    "libBrowse.section": "SECTION LIBRARY",
    "libBrowse.titleA": "Community",
    "libBrowse.titleB": "library",
    "libBrowse.tagline": "Lists curated and shared by other explorers.",
    "libBrowse.tabKits": "Kits {n}",
    "libBrowse.tabCategories": "Categories {n}",
    "libBrowse.tabTrips": "Trips {n}",
    "libBrowse.filterAll": "All",
    "libBrowse.filterRegion": "Region",
    "libBrowse.filterActivity": "Activity",
    "libBrowse.empty": "Nothing here yet.",
    "libBrowse.emptyHint": "Be the first to publish a {kind} for this filter.",
    "libBrowse.emptyAll": "The library is empty for now.",
    "libBrowse.emptyAllHint": "Publish a kit, category, or trip from your inventory.",
    "libBrowse.publishedBy": "Published by",
    "libBrowse.viewItem": "View details",
    "libBrowse.imports_one": "1 import",
    "libBrowse.imports_many": "{n} imports",
    "libBrowse.views_one": "1 view",
    "libBrowse.views_many": "{n} views",

    // Library detail / preview
    "libDetail.back": "Back to library",
    "libDetail.publishedBy": "Published by",
    "libDetail.publishedOn": "Published on {date}",
    "libDetail.contents": "Contents",
    "libDetail.import": "Add to my inventory",
    "libDetail.importing": "Importing...",
    "libDetail.imported": "Added to your inventory!",
    "libDetail.alreadyImported": "Already in your inventory",
    "libDetail.report": "Report",
    "libDetail.reportTitle": "Report this item",
    "libDetail.reportSub": "Tell us what's wrong. Reports are reviewed by an admin.",
    "libDetail.reportPh": "Spam, inappropriate content, copyright issue...",
    "libDetail.reportSubmit": "Submit report",
    "libDetail.reportThanks": "Thanks — your report has been submitted.",
    "libDetail.reportClose": "Close",

    // Dashboard library card
    "dash.libraryCardTitle": "The library",
    "dash.libraryCardTag": "Browse and import lists curated by the community",
    "dash.libraryCardCta": "Open library",
    "share.dialogTitle": "Share with another explorer",
    "share.dialogSub": "Send a copy or a live link.",
    "share.recipient": "Recipient",
    "share.tabUsername": "By username",
    "share.tabCode": "Share code",
    "share.tabFile": "Export file",
    "share.usernamePh": "wayfarer, marco, …",
    "share.usernameNotFound": "No user with that name",
    "share.cantShareSelf": "You can't share with yourself",
    "share.codeHint": "A unique code anyone can use to import this.",
    "share.generateCode": "Generate code",
    "share.regenCode": "Generate a new code",
    "share.copyCode": "Copy",
    "share.copied": "Copied",
    "share.fileHint": "Download a .json file you can send anywhere.",
    "share.exportFile": "Download file",
    "share.fileDownloaded": "Downloaded",
    "share.mode": "Mode",
    "share.modeCopy": "Send a Copy",
    "share.modeCopyHint": "Independent — they can edit and delete.",
    "share.modeLive": "Live Link",
    "share.modeLiveHint": "Synced — your edits propagate. Read-only for them.",
    "share.includeItems": "Include items",
    "share.includeItemsHint": "Bring the items in this category along.",
    "share.includePacklists": "Include packlist",
    "share.includePacklistsHint": "Send the trip's packlist (if any) too.",
    "share.includeKits": "Include kits",
    "share.includeKitsHint": "Send referenced kits with the trip.",
    "share.send": "Send share",
    "share.sent": "Share sent",
    "share.sendAgain": "Send another",
    "share.cancel": "Cancel",
    "share.shareCategory": "Share category",
    "share.shareKit": "Share kit",
    "share.shareTrip": "Share trip",

    // Inbox
    "inbox.section": "SECTION INBOX",
    "inbox.titleA": "Shared",
    "inbox.titleB": "with you",
    "inbox.tagline": "Bundles other explorers have sent you.",
    "inbox.tabPending": "Pending {n}",
    "inbox.tabImported": "Imported {n}",
    "inbox.tabImport": "Import file",
    "inbox.empty": "Your inbox is empty.",
    "inbox.emptyHint": "Shares from other explorers will land here.",
    "inbox.emptyImported": "Nothing imported yet.",
    "inbox.from": "From",
    "inbox.received": "Received",
    "inbox.modeBadgeCopy": "Copy",
    "inbox.modeBadgeLive": "Live",
    "inbox.review": "Review",
    "inbox.decline": "Decline",
    "inbox.confirmDecline": "Decline this share? It will be discarded.",
    "inbox.confirmYes": "Yes, decline",
    "inbox.previewTitle": "Review share",
    "inbox.previewItems": "Referenced items",
    "inbox.previewItemsHint": "Pick which items you want to import along with this share.",
    "inbox.previewKits": "Referenced kits",
    "inbox.previewKitsHint": "Pick which kits to import.",
    "inbox.previewPacklist": "Packlist",
    "inbox.alreadyHave": "(already in your inventory)",
    "inbox.accept": "Import",
    "inbox.acceptedAt": "Imported on {date}",
    "inbox.justAccepted": "Imported.",
    "inbox.fileImportTitle": "Import from a file",
    "inbox.fileImportHint": "Upload a .json export from another explorer.",
    "inbox.fileSelect": "Choose file",
    "inbox.fileInvalid": "That file isn't a valid PakMondo export",
    "inbox.linkedFrom": "Shared by {who}",
    "inbox.liveBadge": "LIVE",
    "inbox.readOnly": "Read-only — edits stay with the sender",

    // Dashboard
    "dash.basecamp": "BASECAMP",
    "dash.wayfarer": "Wayfarer",
    "dash.locOff": "Location services off  /  enable in settings",
    "dash.locPending": "Acquiring position...",
    "dash.locDenied": "Location access denied by browser",
    "dash.locUnsupported": "Location unavailable",
    "dash.locUnknown": "Position unknown",
    "loc.cardTitle": "Current Position",
    "loc.refresh": "Refresh",
    "loc.copy": "Copy",
    "loc.copied": "Copied!",
    "loc.send": "Send",
    "loc.lastUpdated": "Last updated",
    "loc.placeUnknown": "Place name unavailable",
    "loc.placeLoading": "Looking up place name...",
    "loc.openMaps": "Open in Google Maps",
    "loc.dialogTitle": "Send my location",
    "loc.sendToMember": "To a PakMondo member",
    "loc.sendToEmail": "To an email address",
    "loc.recipientUsername": "Recipient username",
    "loc.recipientEmail": "Recipient email",
    "loc.optionalMessage": "Add a note (optional)",
    "loc.sendBtn": "Send location",
    "loc.sendingBtn": "Sending...",
    "loc.sentMember": "Location sent to {name}.",
    "loc.sentEmail": "Email sent to {email}.",
    "loc.sendFailed": "Failed to send. Please try again.",
    "loc.noCoordsYet": "Enable location first, then refresh.",
    "loc.fromShare": "shared their location with you",
    "dash.statTrips": "Active Trips",
    "dash.statTripsSub": "Planned",
    "dash.statInventory": "In Inventory",
    "dash.statInventorySub": "Catalogued",
    "dash.statWeight": "Pack Weight",
    "dash.statWeightSub": "Currently packed",
    "dash.statCart": "Cart",
    "dash.statCartSub": "Items pending",
    "dash.kitTitle": "Let's start packing.",
    "dash.navInventory": "Inventory",
    "dash.navInventoryTag": "Items, categories, ADV styles",
    "dash.navTrips": "Trips",
    "dash.navTripsTag": "Plan a new route or revisit the saved",
    "dash.navPacklists": "Packlists",
    "dash.navPacklistsTag": "Plan a trip or revisit a saved packlist",
    "dash.navCart": "Shopping Cart",
    "dash.navCartTag": "Outfit any gaps in your kit",
    "dash.nextDeparture": "Next departure.",
    "dash.noTrip": "NO TRIP ON THE BOOKS",
    "dash.horizon": "The horizon awaits.",
    "dash.planTrip": "Plan a trip",
    "dash.openTrip": "Open trip",
    "dash.attentionRequired": "Attention required",
    "dash.itemsNeedReview_one": "1 item needs review",
    "dash.itemsNeedReview_many": "{count} items need review",
    "dash.expiresInDays_one": "Expires in 1 day",
    "dash.expiresInDays_many": "Expires in {n} days",
    "dash.expiresToday": "Expires today",
    "dash.expiredAgo_one": "Expired 1 day ago",
    "dash.expiredAgo_many": "Expired {n} days ago",
    "dash.moreInInventory": "+{n} more in inventory",
    "dash.reviewExpiring": "Review expiring items",

    // Inventory
    "inv.section": "SECTION INVENTORY",
    "inv.titleA": "The",
    "inv.titleB": "roster",
    "inv.tabItems": "Items",
    "inv.tabCategories": "Categories",
    "inv.tabTravel": "ADV Style",
    "inv.tabKits": "Kits",
    "inv.addItem": "Add item",
    "inv.addCategory": "Add category",
    "inv.addTravel": "Add ADV Style",
    "inv.addKit": "Add kit",
    "inv.filterTitle": "Filtered view",
    "inv.filterSub_one": "Showing 1 item within reminder window",
    "inv.filterSub_many": "Showing {n} items within reminder window",
    "inv.showAll": "Show all items",
    "inv.emptyFilter": "No items in the reminder window",
    "inv.emptyFilterHint": "All your dated items are still safe",
    "inv.emptyItems": "No items catalogued yet",
    "inv.emptyItemsHint": "Add an item to begin",
    "inv.emptyCats": "No categories yet",
    "inv.emptyCatsHint": "Add one to start sorting",
    "inv.emptyTypes": "No ADV Styles yet",
    "inv.emptyTypesHint": "Define one to template your packing lists",
    "inv.colNum": "No.",
    "inv.colItem": "Item",
    "inv.colKit": "Kit",
    "inv.colCategory": "Category",
    "inv.colWeight": "Weight",
    "inv.colExpiry": "Expiry",
    "inv.colPacked": "Pkd",
    "inv.kitsLabel": "kits",
    "inv.badgeConsumable": "Consumable",
    "inv.badgeExpired": "Expired",
    "inv.metaQty": "qty",
    "inv.metaSize": "size",
    "inv.metaExp": "exp",
    "inv.itemsCount_one": "1 item",
    "inv.itemsCount_many": "{n} items",
    "inv.daysLabel": "DAYS",

    // Kits
    "kit.empty": "No kits assembled yet",
    "kit.emptyHint": "Build a kit to template your packs",
    "kit.formTitle": "Assemble a kit",
    "kit.editFormTitle": "Edit kit",
    "kit.fileKit": "File kit",
    "kit.kitName": "Kit Name",
    "kit.kitNamePh": "Weekend Hiking",
    "kit.itemsInKit_one": "1 item",
    "kit.itemsInKit_many": "{n} items",
    "kit.totalWeight": "Total {weight}",
    "kit.editItems": "Edit items",
    "kit.done": "Done",
    "kit.noItems": "No items in this kit",
    "kit.noItemsHint": "Tap Edit items to add gear",
    "kit.allItems": "All inventory items",
    "kit.noInventory": "Inventory is empty — add items first",
    "kit.deleteKit": "Delete kit",
    "kit.confirmDelete": "Delete this kit? Items remain in your inventory.",
    "kit.confirmYes": "Yes, delete",
    "kit.inKit": "In kit",
    "kit.available": "Available",
    "kit.category": "Category",
    "kit.uncategorized": "Uncategorized",
    "kit.assignCategory": "Assign category",
    "kit.changeCategory": "Change category",
    "kit.noCategoriesYet": "Create a category in the Categories tab first",

    // Packlists — top-level entity that combines kits + items for a trip/purpose
    "pl.section": "SECTION PACKLISTS",
    "pl.titleA": "Saved",
    "pl.titleB": "packlists",
    "pl.tagline": "Curated bundles for any expedition.",
    "pl.tabSaved": "Saved {n}",
    "pl.tabCreate": "Create a Packlist",
    "pl.add": "Add packlist",
    "pl.empty": "No packlists yet.",
    "pl.emptyHint": "Build your first packlist to combine kits and items",
    "pl.formTitle": "Compose a packlist",
    "pl.editFormTitle": "Edit packlist",
    "pl.fileBtn": "File packlist",
    "pl.saveBtn": "Save changes",
    "pl.namePh": "Patagonia 14-Day Trek",
    "pl.notes": "Notes",
    "pl.notesPh": "Crossing the Cordillera Darwin range. Cold and wet expected.",
    "pl.kitsHeading": "Kits",
    "pl.itemsHeading": "Items",
    "pl.kitsHint": "Bundle in pre-built kits",
    "pl.itemsHint": "Add individual items à la carte",
    "pl.noKits": "No kits in your inventory yet",
    "pl.noKitsHint": "Build a kit first in the Kits tab",
    "pl.noItems": "No items in your inventory yet",
    "pl.noItemsHint": "Add items first in the Items tab",
    "pl.kitsCount_one": "1 kit",
    "pl.kitsCount_many": "{n} kits",
    "pl.itemsCount_one": "1 item",
    "pl.itemsCount_many": "{n} items",
    "pl.totalUnique": "{n} total items",
    "pl.wantedCount": "wanted",
    "pl.packedCount": "packed",
    "pl.wantToggle": "Want to take",
    "pl.packedToggle": "Packed in bag",
    "pl.colWant": "WANT",
    "pl.colPacked": "PACKED",
    "pl.legend": "Tap the red box for items you need to pack. Tap the green box once it's in your bag.",
    "pl.openBtn": "Open packlist",
    "pl.editBtn": "Edit",
    "pl.deleteBtn": "Delete",
    "pl.downloadPDF": "Download PDF",
    "weather.btn": "Weather check",
    "weather.heading": "FORECAST",
    "weather.title": "Weather check",
    "weather.loading": "Fetching forecast...",
    "weather.noDestination": "Add a destination",
    "weather.noDestinationHint": "This packlist doesn't have a destination set. Edit the packlist and add one (e.g. 'Iceland', 'Patagonia', 'Yosemite') so we can pull the forecast.",
    "weather.geocodeFailed": "Couldn't find that destination. Try a more specific place name (city or region).",
    "weather.forecastFailed": "Couldn't fetch the forecast. Open-Meteo may be unavailable, or the dates are too far out (max 16 days).",
    "weather.unknownError": "Something went wrong fetching the weather.",
    "weather.errorTitle": "Couldn't fetch weather",
    "weather.gapsHeading": "Gaps in your packlist",
    "weather.coveredHeading": "Covered",
    "weather.suggestKeywords": "Look for",
    "weather.allClear": "Looks good for these conditions",
    "weather.allClearHint": "No critical gaps detected based on the forecast. Mild weather expected.",
    "weather.poweredBy": "Forecast",
    "pl.confirmDelete": "Delete this packlist? Kits and items in it remain in your inventory.",
    "pl.confirmYes": "Yes, delete",
    "pl.detailKits": "Kits in this packlist",
    "pl.catLabel": "CATEGORY",
    "pl.detailItems": "Standalone items",
    "pl.detailEmpty": "This packlist is empty — edit it to add kits and items",

    // Dashboard packlists section
    "dash.savedPacklists": "Saved packlists.",
    "dash.noPacklists": "No packlists yet.",
    "dash.noPacklistsHint": "Compose one to get started",
    "dash.viewAllPacklists": "View all packlists",
    "dash.composePacklist": "Compose packlist",

    // Add forms
    "form.newEntry": "NEW ENTRY",
    "form.draft": "Draft",
    "form.itemTitle": "Catalogue an item",
    "form.editItemTitle": "Edit item",
    "form.fileItem": "File item",
    "form.itemName": "Item Name",
    "form.itemNamePh": "Titanium Spork",
    "form.qty": "Quantity",
    "form.size": "Size",
    "form.sizePh": "M  /  8x10  /  500ml",
    "form.weight": "Weight",
    "form.weightPh": "0.05 kg",
    "form.weightPhImperial": "0.10 lb",
    "form.category": "Category",
    "form.consumable": "Consumable",
    "form.consumableHint": "Track for replenishment when low",
    "form.hasExpiry": "Has expiry date?",
    "form.hasExpiryHint": "Track expiration and get reminders",
    "form.expiryDate": "Expiry Date",
    "form.remindMe": "Remind me",
    "form.remind.0": "On expiry day",
    "form.remind.1": "1 day before",
    "form.remind.3": "3 days before",
    "form.remind.7": "1 week before",
    "form.remind.14": "2 weeks before",
    "form.remind.30": "1 month before",
    "form.remind.60": "2 months before",
    "form.remind.90": "3 months before",
    "form.remind.180": "6 months before",
    "form.remind.365": "1 year before",
    "form.catTitle": "New category",
    "form.editCatTitle": "Edit category",
    "form.fileCategory": "File category",
    "form.catName": "Category Name",
    "form.catNamePh": "Hydration",
    "form.typeTitle": "New ADV Style",
    "form.fileType": "File ADV Style",
    "form.typeName": "Style Name",
    "form.typeNamePh": "River Trip",
    "form.climate": "Climate",
    "form.climatePh": "Wet Mild",
    "form.duration": "Duration",
    "form.durationPh": "3-10",

    // Trips
    "trips.section": "SECTION TRIPS",
    "trips.titleA": "Where to",
    "trips.titleB": "next",
    "trips.tabSaved": "Saved {n}",
    "trips.tabCreate": "Create a Trip",
    "trips.empty": "The map is blank.",
    "trips.emptyHint": "File your first trip",
    "trips.colDeparture": "DEPARTURE",
    "trips.colType": "STYLE",
    "trips.itinerary": "Itinerary",
    "trips.formCode": "Form 04-B",
    "trips.tripName": "Trip Name",
    "trips.tripNamePh": "The Long Way Round",
    "trips.destination": "Destination",
    "trips.destinationPh": "Reykjavik, IS",
    "trips.startDate": "Start Date",
    "trips.endDate": "End Date",
    "trips.tripType": "ADV Style",
    "trips.selectType": "Select trip type…",
    "trips.newType": "New style",
    "trips.defineType": "Define a new ADV Style",
    "trips.addType": "Add style",
    "trips.fileTrip": "Save Packlist",
    "trips.step1": "Step 1 of 2",
    "trips.step2": "Step 2 of 2",
    "trips.stepDetailsTitle": "Itinerary",
    "trips.stepPackTitle": "Pack the trip",
    "trips.stepPackSub": "Bring categories, kits, and individual items. Anything you add becomes a linked packlist with the trip's name.",
    "trips.next": "Continue",
    "trips.back": "Back",
    "trips.skipPacking": "Skip — file without packing",
    "trips.packCategoriesHeading": "Categories",
    "trips.unifiedTitle": "Your inventory",
    "trips.unifiedSub": "Tap a category or kit to expand it and tick items individually. Or check the box to grab the whole thing.",
    "trips.unifiedSearchPh": "Search items, kits, categories…",
    "trips.unifiedAllInCategory": "Add this whole category",
    "trips.unifiedAllInCategoryHint": "Brings every current and future item in this category.",
    "trips.unifiedExpand": "Show items",
    "trips.unifiedCollapse": "Hide items",
    "trips.unifiedKitItemsHeading": "Items in this kit",
    "trips.unifiedNoCategory": "Uncategorized",
    "trips.unifiedEmptyInventory": "Your inventory is empty. Add items, kits, or categories below.",
    "trips.unifiedQuickAdd": "Quick add new",
    "trips.quickAddHint": "Don't have what you need? Create a new item, kit, or category right here.",
    "qadd.pickFromList": "Pick from your existing",
    "qadd.emptyItems": "You don't have any items yet. Create one below.",
    "qadd.emptyKits": "You don't have any kits yet. Create one below.",
    "qadd.emptyCats": "You don't have any categories yet. Create one below.",
    "qadd.orCreateItem": "Or create a new item",
    "qadd.orCreateKit": "Or create a new kit",
    "qadd.orCreateCat": "Or create a new category",
    "picked.heading": "Currently in this packlist",
    "picked.items": "Items",
    "picked.kits": "Kits",
    "picked.categories": "Categories",
    "picked.emptyItems": "No items added yet. Use the Quick Add buttons above.",
    "picked.emptyKits": "No kits added yet. Use the Quick Add buttons above.",
    "picked.emptyCats": "No categories added yet. Use the Quick Add buttons above.",
    "picked.removeFromPacklist": "Remove from this packlist",
    "addTo.button": "Add to...",
    "addTo.heading": "Add to a Trip/Packlist",
    "addTo.empty": "No saved Trip/Packlists yet.",
    "addTo.newOne": "+ New Trip/Packlist",
    "addTo.newName": "Name (e.g. Patagonia)",
    "addTo.newCreate": "Create",
    "addTo.newCancel": "Cancel",
    "addTo.confirmedFmt": "Added to {name}",
    "addTo.alreadyIn": "Already on this list",
    "trips.kitChip": "KIT",
    "trips.packCategoriesHint": "Adding a category brings every item currently in it.",
    "trips.packKitsHeading": "Kits",
    "trips.packKitsHint": "Pre-built bundles. Live link — kit edits propagate.",
    "trips.packItemsHeading": "Individual items",
    "trips.packItemsHint": "Standalone gear that isn't part of a kit.",
    "trips.packEmptyCats": "No categories yet. Create one in Inventory.",
    "trips.packEmptyKits": "No kits yet. Create one in Inventory.",
    "trips.packEmptyItems": "No items yet. Create one in Inventory.",
    "trips.searchPh": "Search…",
    "trips.addNewItemInline": "+ Add new item",
    "trips.addNewKitInline": "+ Add new kit",
    "trips.addNewCatInline": "+ Add new category",
    "trips.inlineItemName": "Item name",
    "trips.inlineItemWeight": "Weight (e.g. 0.5 kg)",
    "trips.inlineItemCategory": "Category",
    "trips.inlineKitName": "Kit name",
    "trips.inlineCatName": "Category name",
    "trips.inlineSave": "Save",
    "trips.inlineCancel": "Cancel",
    "trips.summarySection": "On this trip",
    "trips.summaryNothing": "Nothing packed yet.",
    "trips.summaryFmt": "{c} categories · {k} kits · {i} items",
    "trips.unspecified": "Unspecified",
    "trips.datePending": "Date pending",
    "trips.destPending": "Destination pending",

    // Cart
    "cart.section": "SECTION PROVISIONING",
    "cart.titleA": "The",
    "cart.titleB": "resupply",
    "cart.add": "Add to cart",
    "cart.empty": "The cart is empty",
    "cart.emptyHint": "Tap Add To Cart to provision",
    "cart.colItem": "Item",
    "cart.colQty": "Qty",
    "cart.colPrice": "Price",
    "cart.subtotal": "Subtotal {n} items",
    "cart.shipping": "Shipping",
    "cart.total": "Total",
    "cart.dispatch": "Dispatch Order",
    "cart.bill": "Bill of Lading",
    "cart.formTitle": "Add to cart",
    "cart.formItemName": "Item Name",
    "cart.formItemNamePh": "Iridium Beacon",
    "cart.formPrice": "Price (USD)",
    "cart.formPricePh": "289.00",

    // Settings
    "set.section": "SECTION CONFIGURATION",
    "set.title": "Settings",
    "set.profile": "Profile",
    "set.name": "Name",
    "set.email": "Email",
    "set.username": "Username",
    "set.region": "Region",
    "set.memberSince": "Member since",
    "set.preferences": "Preferences",
    "set.units": "Units",
    "set.unitsMetric": "Metric",
    "set.unitsImperial": "Imperial",
    "set.unitsHintMetric": "kg, km, °C",
    "set.unitsHintImperial": "lb, mi, °F",
    "set.notifications": "Notifications",
    "set.notificationsValue": "Trip reminders only",
    "set.theme": "Theme",
    "set.themeValue": "Field Cream",
    "set.language": "Language",
    "set.location": "Location",
    "set.locOff": "Off  /  click to allow",
    "set.locAllowed": "Allowed",
    "set.locBlocked": "On  /  blocked by browser",
    "set.locAwaiting": "On  /  awaiting browser prompt",
    "set.locUnsupported": "On  /  unsupported browser",
    "set.locOn": "On",
    "set.allow": "Allow",
    "set.disable": "Disable",
    "set.locBlockedNote": "Your browser is blocking location access. Open the site permissions in your browser address bar to allow it, then return here.",
    "set.subscription": "Subscription",
    "set.plan": "Plan",
    "set.planValue": "Field Membership",
    "set.renews": "Renews",
    "set.payment": "Payment",
    "set.data": "Data",
    "set.storage": "Storage",
    "set.storageReady": "Synced to local store",
    "set.storageSaving": "Saving...",
    "set.storageError": "Storage unavailable",
    "set.storageInit": "Initializing",
    "set.resetData": "Reset all saved data",
    "set.strikeCamp": "Strike camp?",
    "set.strikeNote": "All items, categories, ADV styles, kits, trips, and cart contents will be wiped and replaced with the default sample log. This cannot be undone.",
    "set.confirmWipe": "Yes, wipe data",
    "set.signOut": "Sign out",

    // Category detail view
    "catDetail.openCategory": "Open category",
    "catDetail.itemsHeading": "Items",
    "catDetail.kitsHeading": "Kits",
    "catDetail.empty.items": "No items in this category yet",
    "catDetail.empty.itemsHint": "Add an item to get started",
    "catDetail.empty.kits": "No kits in this category yet",
    "catDetail.empty.kitsHint": "Build a kit and assign it here",
    "catDetail.addItem": "Add item",
    "catDetail.addKit": "Add kit",
    "catDetail.edit": "Edit",
    "catDetail.itemsCount_one": "1 item",
    "catDetail.itemsCount_many": "{n} items",
    "catDetail.kitsCount_one": "1 kit",
    "catDetail.kitsCount_many": "{n} kits",

    // Categories (seed names — kept here for translation)
    "cat.Shelter": "Shelter",
    "cat.Apparel": "Apparel",
    "cat.Navigation": "Navigation",
    "cat.Cooking": "Cooking",
    "cat.First Aid": "First Aid",
    "cat.Tech": "Tech",

    // Travel types (seed)
    "tt.Alpine Trek": "Alpine Trek",
    "tt.Desert Crossing": "Desert Crossing",
    "tt.Coastal Kayak": "Coastal Kayak",
    "tt.Polar Expedition": "Polar Expedition",
    "tt.Jungle Trail": "Jungle Trail",
    "tt.Urban Layover": "Urban Layover",
    "climate.Cold": "Cold",
    "climate.Hot Arid": "Hot Arid",
    "climate.Wet Mild": "Wet Mild",
    "climate.Sub-zero": "Sub-zero",
    "climate.Humid Hot": "Humid Hot",
    "climate.Variable": "Variable",
  },

  es: {
    "brand.tagline": "Preparado, en cualquier lugar.",
    "brand.subline": "Inventario  /  Planificación de Viajes  /  Aprovisionamiento",
    "brand.fieldTested": "Probado en Campo",
    "footer.fieldEd": "ED. CAMPO MMXXV",
    "footer.contact": "CONTACTO: pakmondoapp@gmail.com",
    "common.back": "Atrás",
    "common.cancel": "Cancelar",
    "common.add": "Añadir",
    "common.discard": "Descartar",
    "common.save": "Guardar",
    "common.yes": "Sí",
    "common.no": "No",
    "common.done": "Listo",
    "common.loading": "Levantando el campamento...",
    "common.loadingSub": "Cargando el diario de campo",

    "kitDetail.itemsInKit": "Artículos en este kit",
    "kitDetail.empty": "Este kit está vacío. Añade artículos abajo.",
    "kitDetail.unlinkItem": "Quitar del kit",
    "kitDetail.addExisting": "Añadir artículos existentes",
    "kitDetail.tickToAdd": "Toca un artículo para añadirlo al kit",
    "kitDetail.noOthersToAdd": "No hay otros artículos en tu inventario para añadir.",
    "kitDetail.createNew": "Crear un nuevo artículo",

    "catDetail.itemsInCategory": "Artículos en esta categoría",
    "catDetail.empty": "Aún no hay artículos en esta categoría.",
    "catDetail.unlinkItem": "Quitar de la categoría",
    "catDetail.looseItems": "Otros artículos",
    "catDetail.notInKit": "sin kit",
    "kitsView.categoryGroup": "CATEGORÍA",
    "kitsView.noCategory": "Kits sin categoría",
    "catDetail.addExisting": "Añadir artículos existentes",
    "catDetail.tickToAdd": "Toca un artículo para moverlo a esta categoría",
    "catDetail.noOthersToAdd": "Todos tus artículos ya están en esta categoría.",
    "catDetail.createNew": "Crear un nuevo artículo",

    "itemDetail.category": "Categoría",
    "itemDetail.weight": "Peso",
    "itemDetail.quantity": "Cantidad",
    "itemDetail.size": "Talla",
    "itemDetail.consumable": "Consumible",
    "itemDetail.expiry": "Caduca",
    "itemDetail.notes": "Notas",
    "itemDetail.edit": "Editar",
    "itemDetail.delete": "Borrar del inventario",
    "itemDetail.confirmDelete": "¿Borrar este artículo permanentemente? Se eliminará de todos los kits y listas.",

    "import.button": "Importar",
    "import.heading": "Importación masiva",
    "import.title": "Importar desde hoja de cálculo",
    "import.intro": "Añade artículos y categorías en masa desde un archivo Excel (.xlsx) o CSV. La hoja Items tiene una columna Kit — los artículos con el mismo nombre de kit se agrupan automáticamente. Las entradas existentes nunca se sobrescriben.",
    "import.stepA": "Paso 1 — descargar la plantilla",
    "import.stepB": "Paso 2 — subir tu archivo",
    "import.templateHint": "Descarga una hoja de cálculo inicial con filas de ejemplo. Rellénala con tu equipo, guárdala y súbela aquí.",
    "import.fileHint": "Sube tu archivo .xlsx o .csv. Verás una vista previa antes de guardar nada.",
    "import.downloadTemplate": "Descargar plantilla",
    "import.chooseFile": "Elegir archivo",
    "import.loading": "Leyendo tu archivo...",
    "import.parseError": "No se pudo leer este archivo. Asegúrate de que sea un .xlsx o .csv válido.",
    "import.templateError": "No se pudo generar la plantilla. Inténtalo de nuevo.",
    "import.previewIntro": "Esto es lo que se va a importar. Revísalo y confirma.",
    "import.warnings": "Avisos",
    "import.samplePreview": "Muestra de nombres",
    "import.startOver": "Empezar de nuevo",
    "import.confirm": "Importar todo",
    "import.successTitle": "Importación completada",
    "import.summaryAdded": "Añadidos: {i} artículos, {k} kits, {c} categorías.",
    "import.summarySkipped": "Omitidos: {i} artículos duplicados, {k} kits, {c} categorías (ya en inventario).",

    "welcome.signIn": "Iniciar Sesión",
    "welcome.createAccount": "Crear Cuenta",

    "login.stamp": "Miembro Existente",
    "login.title": "Bienvenido de vuelta",
    "login.sub": "Reanude la expedición.",
    "login.email": "Correo",
    "login.password": "Contraseña",
    "login.submit": "Entrar al Campamento",
    "login.noAccount": "¿Aún sin cuenta?",
    "login.forgotPassword": "¿Contraseña olvidada?",
    "fp.title": "Restablecer",
    "fp.title2": "contraseña",
    "fp.sub": "Te enviaremos un enlace por correo para crear una nueva.",
    "fp.emailLabel": "Correo",
    "fp.emailPh": "explorador@pakmondo.co",
    "fp.send": "Enviar enlace",
    "fp.sent": "Revisa tu correo",
    "fp.sentSub": "Si existe una cuenta con ese correo, recibirás un enlace para restablecer. Caduca en 1 hora.",
    "fp.backToLogin": "Volver a iniciar sesión",
    "fp.newTitle": "Crea una",
    "fp.newTitle2": "contraseña nueva",
    "fp.newSub": "Introduce una contraseña nueva para terminar.",
    "fp.newPwLabel": "Contraseña nueva",
    "fp.newPwPh": "Mínimo 6 caracteres",
    "fp.confirmPwLabel": "Confirmar contraseña",
    "fp.confirmPwPh": "Escríbela otra vez",
    "fp.mismatch": "Las contraseñas no coinciden",
    "fp.tooShort": "La contraseña debe tener al menos 6 caracteres",
    "fp.update": "Actualizar contraseña",
    "fp.updated": "Contraseña actualizada. Inicia sesión con la nueva.",
    "fp.linkExpired": "Este enlace ha caducado o no es válido. Solicita uno nuevo.",

    "signup.stamp": "Nueva Inscripción",
    "signup.title1": "Únete a la",
    "signup.title2": "expedición.",
    "signup.identity": "Identidad",
    "signup.required": "Requerido",
    "signup.fullName": "Nombre Completo",
    "signup.username": "Nombre de usuario",
    "signup.usernameHint": "Por defecto usa tu nombre. Debe ser único.",
    "signup.usernamePh": "explorador",
    "signup.usernameTaken": "Ya está en uso — prueba otro",
    "signup.usernameInvalid": "Solo letras, números, punto, guion bajo y guion",
    "signup.usernameAvailable": "Disponible",
    "signup.region": "Región",
    "signup.regionHint": "¿Dónde basas tus expediciones?",
    "signup.regionPlaceholder": "Selecciona una región",
    "signup.passwordHint": "Mín. 8 caracteres",
    "signup.provisions": "Provisiones",
    "signup.priceLabel": "9 $ / mes",
    "signup.cardNumber": "Número de Tarjeta",
    "signup.expiry": "Caducidad",
    "signup.cvc": "CVC",
    "signup.fieldMembership": "Membresía de Campo",
    "signup.submit": "Establecer Campamento",

    "nav.camp": "Inicio",
    "nav.inventory": "Inventario",
    "nav.trips": "Viajes",
    "nav.packlists": "Listas",
    "nav.cart": "Carrito",
    "nav.inbox": "Bandeja",
    "nav.library": "Biblioteca",

    "share.btn": "Compartir",

    "lib.publishBtn": "Publicar en biblioteca",
    "lib.publishedBadge": "Publicado",
    "lib.pendingBadge": "En revisión",
    "lib.rejectedBadge": "Rechazado",
    "lib.dialogTitle": "Publicar en la biblioteca comunitaria",
    "lib.dialogSub": "Las publicaciones curadas aparecen en la Biblioteca pública para que cualquier explorador pueda navegarlas e importarlas.",
    "lib.fieldTitle": "Título",
    "lib.optionalSuffix": "(opcional)",
    "lib.fieldTitleHint": "¿Cómo debería aparecer en la biblioteca?",
    "lib.fieldActivity": "Actividad",
    "lib.fieldActivityHint": "Elige la mejor opción, o escribe una nueva.",
    "lib.activityPh": "Trekking, Acampar, …",
    "lib.activityCustomLabel": "Usar \"{name}\" como actividad nueva",
    "lib.fieldDescription": "Descripción",
    "lib.fieldDescriptionHint": "¿Para qué sirve? ¿Cuándo/dónde lo usaste? ¿Por qué es útil?",
    "lib.descriptionPh": "Tres semanas en la Cordillera Darwin. Húmedo, frío, expuesto.",
    "lib.submit": "Enviar para revisión",
    "lib.submitting": "Enviando...",
    "lib.submitted": "¡Enviado! Un administrador lo revisará en breve.",
    "lib.cancel": "Cancelar",
    "lib.titleRequired": "El título es obligatorio",
    "lib.activityRequired": "La actividad es obligatoria",
    "lib.descriptionRequired": "Se requiere una breve descripción",

    "lib.mySubsTitle": "Mis publicaciones",
    "admin.reviewBtn": "Revisar todas las publicaciones",
    "admin.reviewHeading": "ADMIN",
    "admin.reviewTitle": "Revisión de publicaciones",
    "admin.reviewSub": "Revisa cada publicación de la comunidad. Aprueba para publicar, rechaza con una razón si no cumple.",
    "admin.empty": "No hay publicaciones en este estado.",
    "admin.filter.pending": "Pendientes",
    "admin.filter.approved": "Aprobadas",
    "admin.filter.rejected": "Rechazadas",
    "admin.filter.all": "Todas",
    "admin.currentStatus": "Estado",
    "admin.rejectionReason": "Razón",
    "admin.itemsInKit": "Artículos en este kit",
    "admin.itemsInCategory": "Artículos en esta categoría",
    "admin.kitsInTrip": "Kits en este viaje",
    "admin.standaloneItems": "Artículos individuales",
    "admin.btnApprove": "Aprobar",
    "admin.btnReject": "Rechazar",
    "admin.confirmReject": "Confirmar rechazo",
    "admin.rejectingTitle": "Rechazando publicación",
    "admin.rejectingHint": "Opcional: dile al autor qué estuvo mal. Lo verá en su página Mis Publicaciones.",
    "admin.rejectReasonPh": "p.ej. duplicado de otro elemento, faltan detalles, fuera de tema...",
    "admin.noActivity": "sin actividad",
    "lib.mySubsEmpty": "Aún no has publicado nada.",
    "lib.mySubsEmptyHint": "Publica un kit, categoría o viaje desde su menú de compartir.",
    "lib.subStatusPending": "EN REVISIÓN",
    "lib.subStatusApproved": "APROBADO",
    "lib.subStatusRejected": "RECHAZADO",
    "lib.subDelete": "Borrar publicación",
    "lib.subDeleteConfirm": "¿Borrar esta publicación? La elimina de la biblioteca. Quien ya la haya importado conserva su copia.",
    "lib.subDeleteYes": "Sí, borrar",
    "lib.subRejectReason": "Motivo: {r}",
    "lib.viewMySubs": "Ver mis publicaciones",

    "libBrowse.section": "SECCIÓN BIBLIOTECA",
    "libBrowse.titleA": "Biblioteca",
    "libBrowse.titleB": "comunitaria",
    "libBrowse.tagline": "Listas curadas y compartidas por otros exploradores.",
    "libBrowse.tabKits": "Kits {n}",
    "libBrowse.tabCategories": "Categorías {n}",
    "libBrowse.tabTrips": "Viajes {n}",
    "libBrowse.filterAll": "Todo",
    "libBrowse.filterRegion": "Región",
    "libBrowse.filterActivity": "Actividad",
    "libBrowse.empty": "Nada aquí todavía.",
    "libBrowse.emptyHint": "Sé el primero en publicar un {kind} para este filtro.",
    "libBrowse.emptyAll": "La biblioteca está vacía por ahora.",
    "libBrowse.emptyAllHint": "Publica un kit, categoría o viaje desde tu inventario.",
    "libBrowse.publishedBy": "Publicado por",
    "libBrowse.viewItem": "Ver detalles",
    "libBrowse.imports_one": "1 importación",
    "libBrowse.imports_many": "{n} importaciones",
    "libBrowse.views_one": "1 vista",
    "libBrowse.views_many": "{n} vistas",

    "libDetail.back": "Volver a la biblioteca",
    "libDetail.publishedBy": "Publicado por",
    "libDetail.publishedOn": "Publicado el {date}",
    "libDetail.contents": "Contenido",
    "libDetail.import": "Añadir a mi inventario",
    "libDetail.importing": "Importando...",
    "libDetail.imported": "¡Añadido a tu inventario!",
    "libDetail.alreadyImported": "Ya está en tu inventario",
    "libDetail.report": "Reportar",
    "libDetail.reportTitle": "Reportar este elemento",
    "libDetail.reportSub": "Cuéntanos qué problema tiene. Un administrador revisará el reporte.",
    "libDetail.reportPh": "Spam, contenido inapropiado, problema de derechos de autor...",
    "libDetail.reportSubmit": "Enviar reporte",
    "libDetail.reportThanks": "Gracias — tu reporte ha sido enviado.",
    "libDetail.reportClose": "Cerrar",

    "dash.libraryCardTitle": "La biblioteca",
    "dash.libraryCardTag": "Explora e importa listas curadas por la comunidad",
    "dash.libraryCardCta": "Abrir biblioteca",
    "share.dialogTitle": "Comparte con otro explorador",
    "share.dialogSub": "Envía una copia o un enlace en vivo.",
    "share.recipient": "Destinatario",
    "share.tabUsername": "Por usuario",
    "share.tabCode": "Código",
    "share.tabFile": "Archivo",
    "share.usernamePh": "explorador, marco, …",
    "share.usernameNotFound": "No existe ese usuario",
    "share.cantShareSelf": "No puedes compartir contigo mismo",
    "share.codeHint": "Un código único que cualquiera puede usar.",
    "share.generateCode": "Generar código",
    "share.regenCode": "Generar otro",
    "share.copyCode": "Copiar",
    "share.copied": "Copiado",
    "share.fileHint": "Descarga un .json que puedes enviar a cualquier sitio.",
    "share.exportFile": "Descargar archivo",
    "share.fileDownloaded": "Descargado",
    "share.mode": "Modo",
    "share.modeCopy": "Enviar Copia",
    "share.modeCopyHint": "Independiente — pueden editar y borrar.",
    "share.modeLive": "Enlace en Vivo",
    "share.modeLiveHint": "Sincronizado — tus cambios llegan. Solo lectura.",
    "share.includeItems": "Incluir artículos",
    "share.includeItemsHint": "Manda los artículos de esta categoría también.",
    "share.includePacklists": "Incluir lista",
    "share.includePacklistsHint": "Envía la lista del viaje (si existe) también.",
    "share.includeKits": "Incluir kits",
    "share.includeKitsHint": "Envía los kits referenciados con el viaje.",
    "share.send": "Enviar",
    "share.sent": "Enviado",
    "share.sendAgain": "Enviar otro",
    "share.cancel": "Cancelar",
    "share.shareCategory": "Compartir categoría",
    "share.shareKit": "Compartir kit",
    "share.shareTrip": "Compartir viaje",

    "inbox.section": "SECCIÓN BANDEJA",
    "inbox.titleA": "Compartido",
    "inbox.titleB": "contigo",
    "inbox.tagline": "Paquetes que otros exploradores te han enviado.",
    "inbox.tabPending": "Pendientes {n}",
    "inbox.tabImported": "Importados {n}",
    "inbox.tabImport": "Importar archivo",
    "inbox.empty": "Tu bandeja está vacía.",
    "inbox.emptyHint": "Lo que te compartan aparecerá aquí.",
    "inbox.emptyImported": "Nada importado aún.",
    "inbox.from": "De",
    "inbox.received": "Recibido",
    "inbox.modeBadgeCopy": "Copia",
    "inbox.modeBadgeLive": "Vivo",
    "inbox.review": "Revisar",
    "inbox.decline": "Rechazar",
    "inbox.confirmDecline": "¿Rechazar esto? Se descartará.",
    "inbox.confirmYes": "Sí, rechazar",
    "inbox.previewTitle": "Revisar envío",
    "inbox.previewItems": "Artículos referenciados",
    "inbox.previewItemsHint": "Marca qué artículos quieres importar.",
    "inbox.previewKits": "Kits referenciados",
    "inbox.previewKitsHint": "Marca qué kits importar.",
    "inbox.previewPacklist": "Lista",
    "inbox.alreadyHave": "(ya está en tu inventario)",
    "inbox.accept": "Importar",
    "inbox.acceptedAt": "Importado el {date}",
    "inbox.justAccepted": "Importado.",
    "inbox.fileImportTitle": "Importar desde archivo",
    "inbox.fileImportHint": "Sube un .json exportado por otro explorador.",
    "inbox.fileSelect": "Elegir archivo",
    "inbox.fileInvalid": "Ese archivo no es una exportación válida de PakMondo",
    "inbox.linkedFrom": "Compartido por {who}",
    "inbox.liveBadge": "VIVO",
    "inbox.readOnly": "Solo lectura — los cambios quedan con el remitente",

    "dash.basecamp": "CAMPAMENTO BASE",
    "dash.wayfarer": "Caminante",
    "dash.locOff": "Ubicación desactivada  /  actívala en ajustes",
    "dash.locPending": "Adquiriendo posición...",
    "loc.cardTitle": "Posición actual",
    "loc.refresh": "Actualizar",
    "loc.copy": "Copiar",
    "loc.copied": "¡Copiado!",
    "loc.send": "Enviar",
    "loc.lastUpdated": "Última actualización",
    "loc.placeUnknown": "Nombre de lugar no disponible",
    "loc.placeLoading": "Buscando nombre del lugar...",
    "loc.openMaps": "Abrir en Google Maps",
    "loc.dialogTitle": "Enviar mi ubicación",
    "loc.sendToMember": "A un miembro de PakMondo",
    "loc.sendToEmail": "A una dirección de correo",
    "loc.recipientUsername": "Usuario destinatario",
    "loc.recipientEmail": "Correo del destinatario",
    "loc.optionalMessage": "Añade una nota (opcional)",
    "loc.sendBtn": "Enviar ubicación",
    "loc.sendingBtn": "Enviando...",
    "loc.sentMember": "Ubicación enviada a {name}.",
    "loc.sentEmail": "Correo enviado a {email}.",
    "loc.sendFailed": "Error al enviar. Inténtalo de nuevo.",
    "loc.noCoordsYet": "Activa la ubicación primero y luego actualiza.",
    "loc.fromShare": "ha compartido su ubicación contigo",
    "dash.locDenied": "Acceso a ubicación denegado por el navegador",
    "dash.locUnsupported": "Ubicación no disponible",
    "dash.locUnknown": "Posición desconocida",
    "dash.statTrips": "Viajes Activos",
    "dash.statTripsSub": "Planificados",
    "dash.statInventory": "En Inventario",
    "dash.statInventorySub": "Catalogados",
    "dash.statWeight": "Peso de Mochila",
    "dash.statWeightSub": "Empacado actualmente",
    "dash.statCart": "Carrito",
    "dash.statCartSub": "Pendiente",
    "dash.kitTitle": "Empecemos a empacar.",
    "dash.navInventory": "Inventario",
    "dash.navInventoryTag": "Artículos, categorías, estilos ADV",
    "dash.navTrips": "Viajes",
    "dash.navTripsTag": "Planifica una nueva ruta o revisa las guardadas",
    "dash.navPacklists": "Listas",
    "dash.navPacklistsTag": "Planifica un viaje o revisa una lista guardada",
    "dash.navCart": "Carrito de Compra",
    "dash.navCartTag": "Cubre cualquier vacío en tu equipo",
    "dash.nextDeparture": "Próxima salida.",
    "dash.noTrip": "SIN VIAJES PROGRAMADOS",
    "dash.horizon": "El horizonte espera.",
    "dash.planTrip": "Planificar viaje",
    "dash.openTrip": "Abrir viaje",
    "dash.attentionRequired": "Atención requerida",
    "dash.itemsNeedReview_one": "1 artículo requiere revisión",
    "dash.itemsNeedReview_many": "{count} artículos requieren revisión",
    "dash.expiresInDays_one": "Caduca en 1 día",
    "dash.expiresInDays_many": "Caduca en {n} días",
    "dash.expiresToday": "Caduca hoy",
    "dash.expiredAgo_one": "Caducó hace 1 día",
    "dash.expiredAgo_many": "Caducó hace {n} días",
    "dash.moreInInventory": "+{n} más en inventario",
    "dash.reviewExpiring": "Revisar artículos por caducar",

    "inv.section": "SECCIÓN INVENTARIO",
    "inv.titleA": "La",
    "inv.titleB": "lista",
    "inv.tabItems": "Artículos",
    "inv.tabCategories": "Categorías",
    "inv.tabTravel": "Estilo ADV",
    "inv.tabKits": "Kits",
    "inv.addItem": "Añadir artículo",
    "inv.addCategory": "Añadir categoría",
    "inv.addTravel": "Añadir Estilo ADV",
    "inv.addKit": "Añadir kit",
    "inv.filterTitle": "Vista filtrada",
    "inv.filterSub_one": "Mostrando 1 artículo en ventana de aviso",
    "inv.filterSub_many": "Mostrando {n} artículos en ventana de aviso",
    "inv.showAll": "Mostrar todos los artículos",
    "inv.emptyFilter": "Sin artículos en la ventana de aviso",
    "inv.emptyFilterHint": "Todos tus artículos con fecha están a salvo",
    "inv.emptyItems": "Sin artículos catalogados",
    "inv.emptyItemsHint": "Añade un artículo para empezar",
    "inv.emptyCats": "Sin categorías todavía",
    "inv.emptyCatsHint": "Añade una para empezar a clasificar",
    "inv.emptyTypes": "Sin Estilos ADV todavía",
    "inv.emptyTypesHint": "Define uno para preparar listas de equipaje",
    "inv.colNum": "Nº",
    "inv.colItem": "Artículo",
    "inv.colKit": "Kit",
    "inv.colCategory": "Categoría",
    "inv.colWeight": "Peso",
    "inv.colExpiry": "Caducidad",
    "inv.colPacked": "Emp",
    "inv.kitsLabel": "kits",
    "inv.badgeConsumable": "Consumible",
    "inv.badgeExpired": "Caducado",
    "inv.metaQty": "cant",
    "inv.metaSize": "talla",
    "inv.metaExp": "cad",
    "inv.itemsCount_one": "1 artículo",
    "inv.itemsCount_many": "{n} artículos",
    "inv.daysLabel": "DÍAS",

    "kit.empty": "Sin kits ensamblados",
    "kit.emptyHint": "Crea un kit para preparar tus mochilas",
    "kit.formTitle": "Ensamblar un kit",
    "kit.editFormTitle": "Editar kit",
    "kit.fileKit": "Archivar kit",
    "kit.kitName": "Nombre del kit",
    "kit.kitNamePh": "Senderismo Fin de Semana",
    "kit.itemsInKit_one": "1 artículo",
    "kit.itemsInKit_many": "{n} artículos",
    "kit.totalWeight": "Total {weight}",
    "kit.editItems": "Editar artículos",
    "kit.done": "Hecho",
    "kit.noItems": "Kit vacío",
    "kit.noItemsHint": "Pulsa Editar artículos para añadir equipo",
    "kit.allItems": "Todos los artículos del inventario",
    "kit.noInventory": "Inventario vacío — añade artículos primero",
    "kit.deleteKit": "Borrar kit",
    "kit.confirmDelete": "¿Borrar este kit? Los artículos permanecen en tu inventario.",
    "kit.confirmYes": "Sí, borrar",
    "kit.inKit": "En el kit",
    "kit.available": "Disponibles",
    "kit.category": "Categoría",
    "kit.uncategorized": "Sin categoría",
    "kit.assignCategory": "Asignar categoría",
    "kit.changeCategory": "Cambiar categoría",
    "kit.noCategoriesYet": "Crea una categoría en la pestaña Categorías primero",

    "pl.section": "SECCIÓN LISTAS",
    "pl.titleA": "Listas",
    "pl.titleB": "guardadas",
    "pl.tagline": "Conjuntos curados para cualquier expedición.",
    "pl.tabSaved": "Guardadas {n}",
    "pl.tabCreate": "Crear una Lista",
    "pl.add": "Añadir lista",
    "pl.empty": "Sin listas todavía.",
    "pl.emptyHint": "Crea tu primera lista combinando kits y artículos",
    "pl.formTitle": "Componer una lista",
    "pl.editFormTitle": "Editar lista",
    "pl.fileBtn": "Archivar lista",
    "pl.saveBtn": "Guardar cambios",
    "pl.namePh": "Patagonia Trek 14 Días",
    "pl.notes": "Notas",
    "pl.notesPh": "Cruzando la Cordillera Darwin. Frío y lluvia esperados.",
    "pl.kitsHeading": "Kits",
    "pl.itemsHeading": "Artículos",
    "pl.kitsHint": "Incluye kits prearmados",
    "pl.itemsHint": "Añade artículos sueltos",
    "pl.noKits": "Aún sin kits en tu inventario",
    "pl.noKitsHint": "Crea un kit primero en la pestaña Kits",
    "pl.noItems": "Aún sin artículos en tu inventario",
    "pl.noItemsHint": "Añade artículos primero en la pestaña Artículos",
    "pl.kitsCount_one": "1 kit",
    "pl.kitsCount_many": "{n} kits",
    "pl.itemsCount_one": "1 artículo",
    "pl.itemsCount_many": "{n} artículos",
    "pl.totalUnique": "{n} artículos en total",
    "pl.wantedCount": "queridos",
    "pl.packedCount": "empacados",
    "pl.wantToggle": "Llevar",
    "pl.packedToggle": "En la mochila",
    "pl.colWant": "LLEVAR",
    "pl.colPacked": "EMPACADO",
    "pl.legend": "Marca la casilla roja para los artículos que necesitas empacar. Marca la verde cuando ya esté en la mochila.",
    "pl.openBtn": "Abrir lista",
    "pl.editBtn": "Editar",
    "pl.deleteBtn": "Borrar",
    "pl.downloadPDF": "Descargar PDF",
    "weather.btn": "Revisar el tiempo",
    "weather.heading": "PRONÓSTICO",
    "weather.title": "Revisión del tiempo",
    "weather.loading": "Consultando el pronóstico...",
    "weather.noDestination": "Añade un destino",
    "weather.noDestinationHint": "Esta lista no tiene destino. Edítala y añade uno (p.ej. 'Islandia', 'Patagonia', 'Yosemite') para poder consultar el tiempo.",
    "weather.geocodeFailed": "No encontramos ese destino. Prueba con un nombre más específico (ciudad o región).",
    "weather.forecastFailed": "No se pudo obtener el pronóstico. Open-Meteo puede no estar disponible, o las fechas están demasiado lejos (máx 16 días).",
    "weather.unknownError": "Algo salió mal al consultar el tiempo.",
    "weather.errorTitle": "No se pudo obtener el tiempo",
    "weather.gapsHeading": "Huecos en tu lista",
    "weather.coveredHeading": "Cubierto",
    "weather.suggestKeywords": "Busca",
    "weather.allClear": "Bien para estas condiciones",
    "weather.allClearHint": "No hay huecos críticos según el pronóstico. Se espera buen tiempo.",
    "weather.poweredBy": "Datos meteorológicos",
    "pl.confirmDelete": "¿Borrar esta lista? Los kits y artículos permanecen en tu inventario.",
    "pl.confirmYes": "Sí, borrar",
    "pl.detailKits": "Kits en esta lista",
    "pl.catLabel": "CATEGORÍA",
    "pl.detailItems": "Artículos sueltos",
    "pl.detailEmpty": "Esta lista está vacía — edítala para añadir kits y artículos",

    "dash.savedPacklists": "Listas guardadas.",
    "dash.noPacklists": "Sin listas todavía.",
    "dash.noPacklistsHint": "Compón una para empezar",
    "dash.viewAllPacklists": "Ver todas las listas",
    "dash.composePacklist": "Componer lista",

    "form.newEntry": "NUEVA ENTRADA",
    "form.draft": "Borrador",
    "form.itemTitle": "Catalogar un artículo",
    "form.editItemTitle": "Editar artículo",
    "form.fileItem": "Archivar artículo",
    "form.itemName": "Nombre del artículo",
    "form.itemNamePh": "Cuchara de Titanio",
    "form.qty": "Cantidad",
    "form.size": "Talla",
    "form.sizePh": "M  /  8x10  /  500ml",
    "form.weight": "Peso",
    "form.weightPh": "0,05 kg",
    "form.weightPhImperial": "0,10 lb",
    "form.category": "Categoría",
    "form.consumable": "Consumible",
    "form.consumableHint": "Reabastecer cuando esté bajo",
    "form.hasExpiry": "¿Tiene caducidad?",
    "form.hasExpiryHint": "Sigue la caducidad y recibe avisos",
    "form.expiryDate": "Fecha de caducidad",
    "form.remindMe": "Recordarme",
    "form.remind.0": "El día de caducidad",
    "form.remind.1": "1 día antes",
    "form.remind.3": "3 días antes",
    "form.remind.7": "1 semana antes",
    "form.remind.14": "2 semanas antes",
    "form.remind.30": "1 mes antes",
    "form.remind.60": "2 meses antes",
    "form.remind.90": "3 meses antes",
    "form.remind.180": "6 meses antes",
    "form.remind.365": "1 año antes",
    "form.catTitle": "Nueva categoría",
    "form.editCatTitle": "Editar categoría",
    "form.fileCategory": "Archivar categoría",
    "form.catName": "Nombre de categoría",
    "form.catNamePh": "Hidratación",
    "form.typeTitle": "Nuevo Estilo ADV",
    "form.fileType": "Archivar Estilo",
    "form.typeName": "Nombre del Estilo",
    "form.typeNamePh": "Viaje de río",
    "form.climate": "Clima",
    "form.climatePh": "Húmedo Suave",
    "form.duration": "Duración",
    "form.durationPh": "3-10",

    "trips.section": "SECCIÓN VIAJES",
    "trips.titleA": "¿A dónde",
    "trips.titleB": "ahora",
    "trips.tabSaved": "Guardados {n}",
    "trips.tabCreate": "Crear un Viaje",
    "trips.empty": "El mapa está en blanco.",
    "trips.emptyHint": "Archiva tu primer viaje",
    "trips.colDeparture": "SALIDA",
    "trips.colType": "ESTILO",
    "trips.itinerary": "Itinerario",
    "trips.formCode": "Form. 04-B",
    "trips.tripName": "Nombre del viaje",
    "trips.tripNamePh": "El Camino Largo",
    "trips.destination": "Destino",
    "trips.destinationPh": "Reikiavik, IS",
    "trips.startDate": "Fecha de inicio",
    "trips.endDate": "Fecha de fin",
    "trips.tripType": "Estilo ADV",
    "trips.selectType": "Selecciona tipo de viaje…",
    "trips.newType": "Nuevo estilo",
    "trips.defineType": "Define un nuevo Estilo ADV",
    "trips.addType": "Añadir estilo",
    "trips.fileTrip": "Guardar lista",
    "trips.step1": "Paso 1 de 2",
    "trips.step2": "Paso 2 de 2",
    "trips.stepDetailsTitle": "Itinerario",
    "trips.stepPackTitle": "Prepara el viaje",
    "trips.stepPackSub": "Añade categorías, kits y artículos sueltos. Lo que añadas se convierte en una lista vinculada con el nombre del viaje.",
    "trips.next": "Continuar",
    "trips.back": "Atrás",
    "trips.skipPacking": "Saltar — archivar sin preparar",
    "trips.packCategoriesHeading": "Categorías",
    "trips.unifiedTitle": "Tu inventario",
    "trips.unifiedSub": "Toca una categoría o kit para expandirlo y elegir artículos. O marca la casilla para coger todo.",
    "trips.unifiedSearchPh": "Buscar artículos, kits, categorías…",
    "trips.unifiedAllInCategory": "Añadir toda esta categoría",
    "trips.unifiedAllInCategoryHint": "Incluye todos los artículos actuales y futuros de esta categoría.",
    "trips.unifiedExpand": "Mostrar artículos",
    "trips.unifiedCollapse": "Ocultar artículos",
    "trips.unifiedKitItemsHeading": "Artículos en este kit",
    "trips.unifiedNoCategory": "Sin categoría",
    "trips.unifiedEmptyInventory": "Tu inventario está vacío. Añade artículos, kits o categorías abajo.",
    "trips.unifiedQuickAdd": "Añadir nuevo",
    "trips.quickAddHint": "¿No tienes lo que necesitas? Crea un nuevo artículo, kit o categoría aquí mismo.",
    "qadd.pickFromList": "Elige de los existentes",
    "qadd.emptyItems": "Aún no tienes artículos. Crea uno abajo.",
    "qadd.emptyKits": "Aún no tienes kits. Crea uno abajo.",
    "qadd.emptyCats": "Aún no tienes categorías. Crea una abajo.",
    "qadd.orCreateItem": "O crea un nuevo artículo",
    "qadd.orCreateKit": "O crea un nuevo kit",
    "qadd.orCreateCat": "O crea una nueva categoría",
    "picked.heading": "Actualmente en esta lista",
    "picked.items": "Artículos",
    "picked.kits": "Kits",
    "picked.categories": "Categorías",
    "picked.emptyItems": "Aún no hay artículos. Usa los botones de Añadir Nuevo arriba.",
    "picked.emptyKits": "Aún no hay kits. Usa los botones de Añadir Nuevo arriba.",
    "picked.emptyCats": "Aún no hay categorías. Usa los botones de Añadir Nuevo arriba.",
    "picked.removeFromPacklist": "Quitar de esta lista",
    "addTo.button": "Añadir a...",
    "addTo.heading": "Añadir a un Viaje/Lista",
    "addTo.empty": "Aún no hay Viajes/Listas guardados.",
    "addTo.newOne": "+ Nuevo Viaje/Lista",
    "addTo.newName": "Nombre (ej. Patagonia)",
    "addTo.newCreate": "Crear",
    "addTo.newCancel": "Cancelar",
    "addTo.confirmedFmt": "Añadido a {name}",
    "addTo.alreadyIn": "Ya está en esta lista",
    "trips.kitChip": "KIT",
    "trips.packCategoriesHint": "Al añadir una categoría se incluyen todos sus artículos actuales.",
    "trips.packKitsHeading": "Kits",
    "trips.packKitsHint": "Paquetes prearmados. Enlace vivo — los cambios al kit se propagan.",
    "trips.packItemsHeading": "Artículos sueltos",
    "trips.packItemsHint": "Equipo independiente que no es parte de un kit.",
    "trips.packEmptyCats": "Aún no hay categorías. Crea una en Inventario.",
    "trips.packEmptyKits": "Aún no hay kits. Crea uno en Inventario.",
    "trips.packEmptyItems": "Aún no hay artículos. Crea uno en Inventario.",
    "trips.searchPh": "Buscar…",
    "trips.addNewItemInline": "+ Añadir artículo nuevo",
    "trips.addNewKitInline": "+ Añadir kit nuevo",
    "trips.addNewCatInline": "+ Añadir categoría nueva",
    "trips.inlineItemName": "Nombre del artículo",
    "trips.inlineItemWeight": "Peso (ej. 0.5 kg)",
    "trips.inlineItemCategory": "Categoría",
    "trips.inlineKitName": "Nombre del kit",
    "trips.inlineCatName": "Nombre de la categoría",
    "trips.inlineSave": "Guardar",
    "trips.inlineCancel": "Cancelar",
    "trips.summarySection": "En este viaje",
    "trips.summaryNothing": "Aún nada preparado.",
    "trips.summaryFmt": "{c} categorías · {k} kits · {i} artículos",
    "trips.unspecified": "Sin especificar",
    "trips.datePending": "Fecha pendiente",
    "trips.destPending": "Destino pendiente",

    "cart.section": "SECCIÓN APROVISIONAMIENTO",
    "cart.titleA": "El",
    "cart.titleB": "reabastecimiento",
    "cart.add": "Añadir al carrito",
    "cart.empty": "El carrito está vacío",
    "cart.emptyHint": "Pulsa Añadir al Carrito para aprovisionarte",
    "cart.colItem": "Artículo",
    "cart.colQty": "Cant",
    "cart.colPrice": "Precio",
    "cart.subtotal": "Subtotal {n} artículos",
    "cart.shipping": "Envío",
    "cart.total": "Total",
    "cart.dispatch": "Realizar Pedido",
    "cart.bill": "Albarán",
    "cart.formTitle": "Añadir al carrito",
    "cart.formItemName": "Nombre del artículo",
    "cart.formItemNamePh": "Baliza Iridium",
    "cart.formPrice": "Precio (USD)",
    "cart.formPricePh": "289.00",

    "set.section": "SECCIÓN CONFIGURACIÓN",
    "set.title": "Ajustes",
    "set.profile": "Perfil",
    "set.name": "Nombre",
    "set.email": "Correo",
    "set.username": "Usuario",
    "set.region": "Región",
    "set.memberSince": "Miembro desde",
    "set.preferences": "Preferencias",
    "set.units": "Unidades",
    "set.unitsMetric": "Métrico",
    "set.unitsImperial": "Imperial",
    "set.unitsHintMetric": "kg, km, °C",
    "set.unitsHintImperial": "lb, mi, °F",
    "set.notifications": "Notificaciones",
    "set.notificationsValue": "Solo avisos de viaje",
    "set.theme": "Tema",
    "set.themeValue": "Crema de Campo",
    "set.language": "Idioma",
    "set.location": "Ubicación",
    "set.locOff": "Desactivada  /  pulsa para permitir",
    "set.locAllowed": "Permitida",
    "set.locBlocked": "Activada  /  bloqueada por el navegador",
    "set.locAwaiting": "Activada  /  esperando aviso del navegador",
    "set.locUnsupported": "Activada  /  navegador no compatible",
    "set.locOn": "Activada",
    "set.allow": "Permitir",
    "set.disable": "Desactivar",
    "set.locBlockedNote": "Tu navegador está bloqueando el acceso a la ubicación. Abre los permisos del sitio en la barra de direcciones para permitirlo y vuelve aquí.",
    "set.subscription": "Suscripción",
    "set.plan": "Plan",
    "set.planValue": "Membresía de Campo",
    "set.renews": "Se renueva",
    "set.payment": "Pago",
    "set.data": "Datos",
    "set.storage": "Almacenamiento",
    "set.storageReady": "Sincronizado localmente",
    "set.storageSaving": "Guardando...",
    "set.storageError": "Almacenamiento no disponible",
    "set.storageInit": "Inicializando",
    "set.resetData": "Borrar todos los datos",
    "set.strikeCamp": "¿Levantar campamento?",
    "set.strikeNote": "Todos los artículos, categorías, Estilos ADV, kits, viajes y carrito se borrarán y se reemplazarán con el diario de muestra por defecto. Esto no se puede deshacer.",
    "set.confirmWipe": "Sí, borrar datos",
    "set.signOut": "Cerrar sesión",

    "catDetail.openCategory": "Abrir categoría",
    "catDetail.itemsHeading": "Artículos",
    "catDetail.kitsHeading": "Kits",
    "catDetail.empty.items": "Aún no hay artículos en esta categoría",
    "catDetail.empty.itemsHint": "Añade uno para empezar",
    "catDetail.empty.kits": "Aún no hay kits en esta categoría",
    "catDetail.empty.kitsHint": "Crea un kit y asígnalo aquí",
    "catDetail.addItem": "Añadir artículo",
    "catDetail.addKit": "Añadir kit",
    "catDetail.edit": "Editar",
    "catDetail.itemsCount_one": "1 artículo",
    "catDetail.itemsCount_many": "{n} artículos",
    "catDetail.kitsCount_one": "1 kit",
    "catDetail.kitsCount_many": "{n} kits",

    "cat.Shelter": "Refugio",
    "cat.Apparel": "Ropa",
    "cat.Navigation": "Navegación",
    "cat.Cooking": "Cocina",
    "cat.First Aid": "Primeros Auxilios",
    "cat.Tech": "Tecnología",

    "tt.Alpine Trek": "Trekking Alpino",
    "tt.Desert Crossing": "Travesía del Desierto",
    "tt.Coastal Kayak": "Kayak Costero",
    "tt.Polar Expedition": "Expedición Polar",
    "tt.Jungle Trail": "Sendero de Jungla",
    "tt.Urban Layover": "Escala Urbana",
    "climate.Cold": "Frío",
    "climate.Hot Arid": "Cálido Árido",
    "climate.Wet Mild": "Húmedo Suave",
    "climate.Sub-zero": "Bajo cero",
    "climate.Humid Hot": "Húmedo Cálido",
    "climate.Variable": "Variable",
  },
};

const I18nContext = createContext({ lang: "en", t: (k) => k, locale: "en-US", units: "metric" });
const useI18n = () => useContext(I18nContext);

const makeT = (lang) => (key, params = {}) => {
  const dict = TRANSLATIONS[lang] || TRANSLATIONS.en;
  let str = dict[key] != null ? dict[key] : (TRANSLATIONS.en[key] != null ? TRANSLATIONS.en[key] : key);
  Object.keys(params).forEach((k) => { str = str.split(`{${k}}`).join(String(params[k])); });
  return str;
};
// Translate with optional fallback to a literal (used for seed-data names that may
// not have translations — e.g., user-created categories)
const tOrLiteral = (lang, prefix, value) => {
  const k = `${prefix}.${value}`;
  const dict = TRANSLATIONS[lang] || TRANSLATIONS.en;
  return dict[k] != null ? dict[k] : value;
};

/* ============================================================
   useViewport — responsive helper, exposes width + breakpoint flags
   ============================================================ */
const useViewport = () => {
  const [width, setWidth] = useState(
    typeof window !== "undefined" ? window.innerWidth : 1024
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);
  return {
    width,
    isMobile: width < 768,    // iPhone / Android phones
    isNarrow: width < 420,    // small phones (iPhone SE, mini)
  };
};

// Standard responsive padding shorthand
const padX = (isMobile) => (isMobile ? "0 16px 56px" : "0 32px 80px");

const uid = (p) => `${p}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;

/* ============================================================
   Reverse geocoding via OpenStreetMap Nominatim (free, no key).
   Rate limit: ~1 req/sec per app. We cache results in-memory
   so refreshing the same coords doesn't re-hit the API.
   Returns: { city, region, country, full } or null on failure.
   ============================================================ */
const _geocodeCache = new Map();
async function reverseGeocode(lat, lon, lang = "en") {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${lang}`;
  if (_geocodeCache.has(key)) return _geocodeCache.get(key);
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10&accept-language=${lang}`;
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) throw new Error("geocode failed");
    const data = await res.json();
    const a = data.address || {};
    const city = a.city || a.town || a.village || a.hamlet || a.county || "";
    const region = a.state || a.region || "";
    const country = a.country || "";
    const parts = [city, country].filter(Boolean);
    const full = parts.join(", ") || data.display_name || "";
    const result = { city, region, country, full };
    _geocodeCache.set(key, result);
    return result;
  } catch (e) {
    return null;
  }
}

/* Format coordinates for display: "41.3902°N 2.1602°E" */
function formatCoords(lat, lon, decimals = 4) {
  const fmt = (val, pos, neg) => `${Math.abs(val).toFixed(decimals)}°${val >= 0 ? pos : neg}`;
  return `${fmt(lat, "N", "S")} ${fmt(lon, "E", "W")}`;
}

/* Build a Google Maps URL pointing at a coordinate. Works on web + mobile. */
function googleMapsUrl(lat, lon) {
  return `https://www.google.com/maps?q=${lat},${lon}`;
}

/* ============================================================
   Excel/CSV import + template helpers.

   We load the SheetJS (xlsx) library on demand from CDN — it's
   ~400KB so we only pay that cost when the user actually imports.
   ============================================================ */
let _xlsxPromise = null;
function loadXLSX() {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (_xlsxPromise) return _xlsxPromise;
  _xlsxPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    script.onload = () => resolve(window.XLSX);
    script.onerror = () => reject(new Error("Failed to load XLSX library"));
    document.head.appendChild(script);
  });
  return _xlsxPromise;
}

/* Build and download a blank template workbook for bulk import.
   Single Items sheet with 9 columns. Headers only — no example rows.
   Columns: Category | Kit | Item Name | Weight | Quantity | Size |
            Consumable | Expiry | Notes
   Items sharing the same Kit name get auto-grouped into a kit on import.
   Categories listed in the Category column get auto-created if new. */
async function downloadImportTemplate() {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();

  // Header row only — user fills the rest with their own gear.
  const itemsData = [
    ["Category", "Kit", "Item Name", "Weight", "Quantity", "Size", "Consumable", "Expiry", "Notes"],
  ];
  const itemsSheet = XLSX.utils.aoa_to_sheet(itemsData);
  itemsSheet["!cols"] = [
    { wch: 18 }, // Category
    { wch: 22 }, // Kit
    { wch: 24 }, // Item Name
    { wch: 10 }, // Weight
    { wch: 10 }, // Quantity
    { wch: 10 }, // Size
    { wch: 12 }, // Consumable
    { wch: 12 }, // Expiry
    { wch: 30 }, // Notes
  ];
  XLSX.utils.book_append_sheet(wb, itemsSheet, "Items");

  XLSX.writeFile(wb, "PakMondo_Import_Template.xlsx");
}

/* Parse an uploaded XLSX/CSV file into structured objects.
   Returns { items, kits, categories, errors } where:
     - items[] each have { id, name, weight, quantity, ... } (no category)
     - kits[] are auto-derived from unique values in the "Kit" column
       on the Items sheet, with itemIds populated
     - categories[] come from the Categories sheet
     - errors[] are warnings to surface in the UI
   Headers are matched case-insensitively. Both "Item Name" and "name"
   are accepted for backwards compatibility with older templates. */
async function parseInventoryImport(file) {
  const XLSX = await loadXLSX();
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: "array" });

  const errors = [];
  const items = [];
  const kits = [];
  const categories = [];

  // Helper: read a sheet by name (case-insensitive) and return rows as
  // arrays of objects keyed by lowercased header. Empty-row safe.
  const readSheet = (sheetName) => {
    const realName = wb.SheetNames.find((n) => n.toLowerCase() === sheetName.toLowerCase());
    if (!realName) return [];
    const sheet = wb.Sheets[realName];
    const json = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
    // Normalize keys to lowercase for case-insensitive header matching
    return json.map((row) => {
      const out = {};
      Object.keys(row).forEach((k) => { out[k.toLowerCase().trim()] = row[k]; });
      return out;
    });
  };

  // Helper: pick the first non-empty value from a row by trying multiple
  // possible header names (case-insensitive). e.g. pickField(row, "item name", "name")
  // returns whichever the row actually has.
  const pickField = (row, ...candidates) => {
    for (const c of candidates) {
      const v = row[c.toLowerCase()];
      if (v !== undefined && String(v).trim() !== "") return v;
    }
    return "";
  };

  // === ITEMS ===
  const itemRows = readSheet("Items");
  // We track which Kit-column value and Category-column value belong to
  // each parsed item so we can derive kits + auto-create categories below.
  const itemKitMap = []; // parallel array of kit-name strings (or "")
  itemRows.forEach((row, idx) => {
    const name = String(pickField(row, "item name", "name") || "").trim();
    if (!name) {
      // Skip blank rows silently. Only flag rows that have other data but no name.
      const hasOther = Object.values(row).some((v) => String(v).trim());
      if (hasOther) errors.push(`Items row ${idx + 2}: missing Item Name (skipped)`);
      return;
    }
    const consumableRaw = String(pickField(row, "consumable")).toLowerCase().trim();
    const consumable = ["true", "yes", "y", "1", "sí", "si"].includes(consumableRaw);
    const quantity = parseInt(pickField(row, "quantity"), 10);
    const itemCategory = String(pickField(row, "category") || "").trim() || null;
    const item = {
      id: uid("it"),
      name,
      category: itemCategory, // read from the Category column on the Items sheet
      weight: String(pickField(row, "weight") || "").trim() || null,
      quantity: isNaN(quantity) ? 1 : quantity,
      size: String(pickField(row, "size") || "").trim() || null,
      consumable,
      expiry: String(pickField(row, "expiry") || "").trim() || null,
      notes: String(pickField(row, "notes") || "").trim() || null,
      packed: false,
    };
    items.push(item);
    itemKitMap.push(String(pickField(row, "kit") || "").trim());
  });

  // === KITS — derived from the Kit column on the Items sheet ===
  // Group all items that share the same Kit name into a single kit. Kit
  // names are case-insensitive (so "Cold Camp" and "cold camp" merge).
  // The kit's category is set to the most common category among its items.
  const kitMap = new Map(); // lowercased kit name -> { name, itemIds[], categoryCounts: Map }
  items.forEach((it, i) => {
    const kitName = itemKitMap[i];
    if (!kitName) return; // standalone item, no kit
    const key = kitName.toLowerCase();
    if (!kitMap.has(key)) {
      kitMap.set(key, { id: uid("kit"), name: kitName, itemIds: [], categoryCounts: new Map() });
    }
    const k = kitMap.get(key);
    k.itemIds.push(it.id);
    if (it.category) {
      k.categoryCounts.set(it.category, (k.categoryCounts.get(it.category) || 0) + 1);
    }
  });
  kitMap.forEach((kit) => {
    // Pick the most-frequent category among items in this kit, if any
    let bestCat = null;
    let bestCount = 0;
    kit.categoryCounts.forEach((count, cat) => {
      if (count > bestCount) { bestCat = cat; bestCount = count; }
    });
    kits.push({
      id: kit.id,
      name: kit.name,
      category: bestCat,
      itemIds: kit.itemIds,
    });
  });

  // === CATEGORIES — auto-derived from the Category column on Items ===
  // Any unique Category value seen on items becomes a new category.
  // Case-insensitive dedup.
  const catSet = new Map(); // lowercased -> original casing
  items.forEach((it) => {
    if (it.category) {
      const k = it.category.toLowerCase();
      if (!catSet.has(k)) catSet.set(k, it.category);
    }
  });
  catSet.forEach((displayName) => {
    categories.push({
      id: uid("cat"),
      name: displayName,
      icon: "tag",
    });
  });

  // === CATEGORIES SHEET (legacy / optional) ===
  // If the user has a "Categories" sheet from an old template, still read it
  // and merge any names that aren't already derived from items.
  const catRows = readSheet("Categories");
  catRows.forEach((row, idx) => {
    const name = String(pickField(row, "category name", "name") || "").trim();
    if (!name) return; // silent on blank rows for legacy sheet
    if (catSet.has(name.toLowerCase())) return; // already added from items
    catSet.set(name.toLowerCase(), name);
    categories.push({
      id: uid("cat"),
      name,
      icon: String(pickField(row, "icon") || "tag").trim() || "tag",
    });
  });

  return { items, kits, categories, errors };
}


// === Unit conversion helpers ===
// Items always store weight as a string like "2.10 kg" (the value is canonical metric).
// formatWeight() reads that, converts to imperial if needed, and returns a display string.
const KG_TO_LB = 2.2046226218;
const parseKg = (str) => {
  if (typeof str !== "string") return 0;
  // Match "2.10 kg" or "1500 g" or just "2.10"
  const m = str.match(/(-?\d+(?:\.\d+)?)\s*(kg|g|lb|oz)?/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const u = (m[2] || "kg").toLowerCase();
  if (u === "g") return v / 1000;
  if (u === "lb") return v / KG_TO_LB;
  if (u === "oz") return v / KG_TO_LB / 16;
  return v;
};
const formatWeight = (str, units) => {
  if (!str) return "";
  const kg = parseKg(str);
  if (units === "imperial") {
    const lb = kg * KG_TO_LB;
    return `${lb.toFixed(2)} lb`;
  }
  return `${kg.toFixed(2)} kg`;
};
const formatWeightFromKg = (kg, units) => {
  if (units === "imperial") return `${(kg * KG_TO_LB).toFixed(2)} lb`;
  return `${kg.toFixed(2)} kg`;
};

const Coord = ({ children }) => (
  <span style={{ fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.05em" }}>{children}</span>
);

const DashLine = () => (
  <div style={{ width: "100%", height: 1, backgroundImage: `linear-gradient(to right, ${C.line} 50%, transparent 50%)`, backgroundSize: "8px 1px", backgroundRepeat: "repeat" }} />
);

const Stamp = ({ children, rotate = -8, color = C.rust }) => (
  <div style={{ display: "inline-flex", alignItems: "center", padding: "4px 12px", border: `2px double ${color}`, color, transform: `rotate(${rotate}deg)`, fontFamily: F.mono, fontSize: 11, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase" }}>
    {children}
  </div>
);

// === REGIONS ===
// Each badge uses a distinctive accent color drawn from the existing palette
// + a small abstract SVG glyph evoking the geography. Two-letter code shown prominently.
const REGIONS = [
  { code: "NA", labelEn: "North America",  labelEs: "Norteamérica",   color: "#B8451F" }, // rust
  { code: "SA", labelEn: "South America",  labelEs: "Sudamérica",     color: "#C68B36" }, // ochre
  { code: "EU", labelEn: "Europe",         labelEs: "Europa",         color: "#2D4A3E" }, // forest
  { code: "AS", labelEn: "Asia",           labelEs: "Asia",           color: "#6B4226" }, // burnt sienna
  { code: "OC", labelEn: "Oceania",        labelEs: "Oceanía",        color: "#3B6B7A" }, // teal
  { code: "AF", labelEn: "Africa",         labelEs: "África",         color: "#8B5A2B" }, // saddle
];

const regionLabel = (code, lang) => {
  const r = REGIONS.find((x) => x.code === code);
  if (!r) return "";
  return lang === "es" ? r.labelEs : r.labelEn;
};

// Each region gets a unique abstract glyph behind the two-letter code.
// All glyphs use stroke="currentColor" so they pick up the accent.
const RegionGlyph = ({ code }) => {
  // Tiny accent glyph drawn behind the letters — keeps it readable
  // when the badge is small (header chip) but adds character.
  switch (code) {
    case "NA": // peaks (mountains)
      return <path d="M2 14 L6 8 L9 11 L13 5 L18 14 Z" fill="currentColor" opacity="0.15" />;
    case "SA": // single tall peak (Andes)
      return <path d="M3 14 L10 4 L17 14 Z" fill="currentColor" opacity="0.15" />;
    case "EU": // arched bridge / classical motif
      return <path d="M2 13 Q10 4 18 13 L18 14 L2 14 Z" fill="currentColor" opacity="0.15" />;
    case "AS": // pagoda / stepped tier
      return <path d="M5 6 L15 6 L13 9 L7 9 Z M3 9 L17 9 L15 12 L5 12 Z M2 12 L18 12 L18 14 L2 14 Z" fill="currentColor" opacity="0.15" />;
    case "OC": // wave
      return <path d="M2 11 Q5 7 8 11 T14 11 T20 11 L20 14 L2 14 Z" fill="currentColor" opacity="0.15" />;
    case "AF": // acacia / sun on horizon
      return <g fill="currentColor" opacity="0.15">
        <circle cx="10" cy="10" r="3" />
        <rect x="2" y="13" width="16" height="1" />
      </g>;
    default:
      return null;
  }
};

// Two sizes:
//   compact: small inline chip used after the user's name
//   detail:  larger version used in Settings / Signup preview
const RegionBadge = ({ code, size = "compact" }) => {
  const region = REGIONS.find((r) => r.code === code);
  if (!region) return null;
  const isDetail = size === "detail";
  const W = isDetail ? 64 : 44;
  const H = isDetail ? 22 : 18;
  const fontSize = isDetail ? 11 : 9;

  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: W,
      height: H,
      position: "relative",
      verticalAlign: "middle",
      flexShrink: 0,
    }}>
      <svg width={W} height={H} viewBox="0 0 20 14" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, color: region.color }}>
        <rect x="0.5" y="0.5" width="19" height="13" fill={region.color} fillOpacity="0.1" stroke={region.color} strokeWidth="0.7" />
        <RegionGlyph code={code} />
      </svg>
      <span style={{
        position: "relative",
        fontFamily: F.mono,
        fontSize: fontSize,
        fontWeight: 700,
        letterSpacing: "0.14em",
        color: region.color,
      }}>
        {code}
      </span>
    </span>
  );
};

const Btn = ({ children, onClick, variant = "primary", icon: Icon, disabled, fullWidth }) => {
  const styles = variant === "primary" ? { background: C.ink, color: C.paper, border: "none" }
    : variant === "rust" ? { background: C.rust, color: C.paper, border: "none" }
    : variant === "ghost" ? { background: "transparent", color: C.ink, border: `1.5px solid ${C.ink}` }
    : { background: C.paperDeep, color: C.ink, border: "none" };
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      style={{ display: fullWidth ? "flex" : "inline-flex", width: fullWidth ? "100%" : undefined, minHeight: 44, alignItems: "center", justifyContent: "center", gap: 8, padding: "12px 20px", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, fontFamily: F.body, fontWeight: 600, letterSpacing: "0.04em", fontSize: 13, textTransform: "uppercase", ...styles }}>
      {Icon && <Icon size={16} strokeWidth={2} />}
      <span>{children}</span>
    </button>
  );
};

const Field = ({ label, type = "text", icon: Icon, value, onChange, placeholder }) => (
  <label style={{ display: "block" }}>
    <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
      {Icon && <Icon size={11} />}{label}
    </div>
    <input type={type} value={value} onChange={onChange} placeholder={placeholder}
      style={{ width: "100%", padding: "10px 0", background: "transparent", border: "none", borderBottom: `1.5px solid ${C.ink}`, outline: "none", fontFamily: F.body, fontSize: 16, color: C.ink }} />
  </label>
);

const EmptyState = ({ label, hint }) => (
  <div style={{ padding: 48, textAlign: "center", border: `1.5px dashed ${C.line}`, background: C.paperDeep }}>
    <div style={{ fontFamily: F.display, fontStyle: "italic", fontSize: 24, color: C.inkSoft }}>{label}</div>
    <div style={{ marginTop: 8, fontFamily: F.mono, fontSize: 11, letterSpacing: "0.15em", color: C.muted, textTransform: "uppercase" }}>{hint}</div>
  </div>
);

const Row = ({ label, value }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
    <div style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", opacity: 0.7 }}>{label}</div>
    <div style={{ fontFamily: F.mono, fontSize: 16 }}>{value}</div>
  </div>
);

const TopoBG = ({ opacity = 0.12 }) => (
  <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", opacity }} viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice">
    <g fill="none" stroke={C.forest} strokeWidth="0.7">
      <path d="M -50,300 Q 200,200 400,280 T 850,260" />
      <path d="M -50,330 Q 200,230 400,310 T 850,290" />
      <path d="M -50,370 Q 200,270 400,350 T 850,330" />
      <path d="M -50,420 Q 200,320 400,400 T 850,380" />
      <path d="M -50,480 Q 200,380 400,460 T 850,440" />
      <ellipse cx="200" cy="180" rx="160" ry="60" />
      <ellipse cx="200" cy="180" rx="120" ry="42" />
      <ellipse cx="600" cy="120" rx="180" ry="50" />
      <ellipse cx="600" cy="120" rx="130" ry="34" />
    </g>
  </svg>
);

const CompassRose = ({ size = 80 }) => (
  <svg viewBox="0 0 100 100" width={size} height={size}>
    <g fill="none" stroke={C.ink} strokeWidth="0.8">
      <circle cx="50" cy="50" r="46" />
      <circle cx="50" cy="50" r="36" strokeDasharray="2 2" />
      <circle cx="50" cy="50" r="4" fill={C.rust} stroke="none" />
    </g>
    <polygon points="50,8 54,50 50,46 46,50" fill={C.rust} />
    <polygon points="50,92 54,50 50,54 46,50" fill={C.ink} />
    <polygon points="8,50 50,46 54,50 50,54" fill={C.ink} />
    <polygon points="92,50 50,46 46,50 50,54" fill={C.ink} />
  </svg>
);

const SectionHeader = ({ num, label, right }) => (
  <div style={{ marginBottom: 24, paddingBottom: 12, borderBottom: `1.5px solid ${C.ink}`, fontFamily: F.mono, fontSize: 11, letterSpacing: "0.2em", textTransform: "uppercase", display: "flex", justifyContent: "space-between" }}>
    <span>{num} {label}</span>
    <span style={{ color: C.muted }}>{right}</span>
  </div>
);

const DAY_MS = 86400000;

// Returns items whose reminder date has arrived (or are already expired).
const getExpiryAlerts = (items) => {
  const now = Date.now();
  return items.filter((it) => {
    if (!it.expiry) return false;
    const exp = new Date(it.expiry).getTime();
    if (isNaN(exp)) return false;
    const lead = (typeof it.remindDays === "number" && it.remindDays >= 0) ? it.remindDays : 30;
    return now >= exp - lead * DAY_MS;
  });
};

// Days remaining (negative if past expiry).
const daysUntil = (iso) => {
  const exp = new Date(iso).getTime();
  if (isNaN(exp)) return null;
  return Math.ceil((exp - Date.now()) / DAY_MS);
};

const AlertBadge = ({ count, size = 22 }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      minWidth: size,
      height: size,
      padding: count && count > 1 ? "0 6px" : 0,
      background: C.rust,
      color: C.paper,
      fontFamily: F.mono,
      fontSize: Math.max(10, size - 12),
      fontWeight: 900,
      letterSpacing: count && count > 1 ? "0.05em" : 0,
      lineHeight: 1,
      border: `1.5px solid ${C.ink}`,
    }}
    aria-label={count ? `${count} alerts` : "alert"}
  >
    {count && count > 1 ? `! ${count}` : "!"}
  </span>
);

const SEED_CATEGORIES = [
  { id: "cat-1", name: "Shelter", icon: "tent", count: 6 },
  { id: "cat-2", name: "Apparel", icon: "backpack", count: 14 },
  { id: "cat-3", name: "Navigation", icon: "compass", count: 5 },
  { id: "cat-4", name: "Cooking", icon: "flame", count: 9 },
  { id: "cat-5", name: "First Aid", icon: "tag", count: 12 },
  { id: "cat-6", name: "Tech", icon: "layers", count: 7 },
];
/* ============================================================
   TRIP TYPE ICONS — 13 icons (12 adventure styles + Other)
   Each icon is single-stroke 2px, currentColor for theming.
   Designed to render at 64x64 viewBox; scales cleanly to any size.
   ============================================================ */
const TT_ICONS = {
  "bike-packer":   <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="14" cy="46" r="8"/><circle cx="50" cy="46" r="8"/><path d="M14 46 L30 26 L42 26 L50 46"/><path d="M30 26 L24 22 L20 22"/><rect x="34" y="18" width="14" height="10" rx="1.5"/></g>,
  "comfort":       <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="20" x2="12" y2="48"/><line x1="52" y1="20" x2="52" y2="48"/><path d="M8 20 Q12 14 16 20"/><path d="M48 20 Q52 14 56 20"/><path d="M12 28 Q32 46 52 28"/><line x1="12" y1="28" x2="14" y2="26"/><line x1="52" y1="28" x2="50" y2="26"/></g>,
  "cultural":      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 22 L32 10 L54 22"/><line x1="12" y1="22" x2="52" y2="22"/><line x1="18" y1="22" x2="18" y2="48"/><line x1="32" y1="22" x2="32" y2="48"/><line x1="46" y1="22" x2="46" y2="48"/><line x1="10" y1="48" x2="54" y2="48"/></g>,
  "digital-nomad": <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="14" y="18" width="36" height="22" rx="2"/><path d="M10 44 L54 44 L50 40 L14 40 Z"/><circle cx="32" cy="29" r="6"/><line x1="26" y1="29" x2="38" y2="29"/><path d="M32 23 Q27 29 32 35"/><path d="M32 23 Q37 29 32 35"/></g>,
  "documentary":   <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="20" width="48" height="28" rx="3"/><path d="M22 20 L26 14 L38 14 L42 20"/><circle cx="32" cy="34" r="8"/><circle cx="32" cy="34" r="3"/><circle cx="48" cy="26" r="1.2" fill="currentColor"/></g>,
  "expeditionist": <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 50 L22 28 L34 40 L46 22 L58 50 Z"/><line x1="46" y1="22" x2="46" y2="8"/><path d="M46 8 L56 12 L46 16"/></g>,
  "extreme-adv":   <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="46" r="8"/><circle cx="50" cy="46" r="8"/><path d="M18 46 L26 30 L42 30 L46 38"/><path d="M26 30 L22 24 L18 24"/><path d="M42 30 L48 24"/><line x1="10" y1="38" x2="4" y2="38"/><line x1="10" y1="46" x2="4" y2="46"/><line x1="10" y1="54" x2="4" y2="54"/></g>,
  "hiker":         <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 16 L26 16 L28 30 L46 30 L52 36 L52 46 L16 46 Z"/><line x1="16" y1="40" x2="52" y2="40"/><line x1="18" y1="22" x2="26" y2="22"/><line x1="18" y1="26" x2="26" y2="26"/></g>,
  "nature":        <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="46" cy="18" r="5"/><path d="M6 50 L20 30 L30 40 L40 26 L58 50 Z"/></g>,
  "overlander":    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 32 L14 22 L50 22 L56 32 L56 42 L8 42 Z"/><line x1="8" y1="42" x2="56" y2="42"/><line x1="14" y1="20" x2="50" y2="20"/><line x1="14" y1="22" x2="14" y2="20"/><line x1="50" y1="22" x2="50" y2="20"/><line x1="32" y1="22" x2="32" y2="20"/><circle cx="20" cy="46" r="5"/><circle cx="44" cy="46" r="5"/></g>,
  "pathfinder":    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="32" cy="32" r="20"/><path d="M32 16 L37 32 L32 48 L27 32 Z"/><circle cx="32" cy="32" r="1.5" fill="currentColor"/><line x1="32" y1="10" x2="32" y2="13"/></g>,
  "primitive":     <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="10" y1="50" x2="54" y2="50"/><line x1="14" y1="50" x2="48" y2="40"/><line x1="50" y1="50" x2="16" y2="40"/><path d="M32 14 Q24 24 28 32 Q32 26 32 32 Q36 26 36 22 Q42 30 36 38 L28 38 Q22 30 32 14 Z"/></g>,
  "other":         <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="32" cy="32" r="22"/><path d="M24 24 Q24 16 32 16 Q40 16 40 24 Q40 30 32 32 L32 38"/><circle cx="32" cy="46" r="1.5" fill="currentColor"/></g>,
};

/* TripTypeBadge — square ochre tile with the trip-type icon in black.
   Used everywhere a trip type is displayed (chips, cards, detail). */
function TripTypeBadge({ iconKey, size = 36 }) {
  const innerSvg = TT_ICONS[iconKey] || TT_ICONS["other"];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: size, height: size,
      background: C.ochre, color: "#000",
      flexShrink: 0,
    }} aria-hidden="true">
      <svg viewBox="0 0 64 64" width={Math.round(size * 0.72)} height={Math.round(size * 0.72)}>
        {innerSvg}
      </svg>
    </span>
  );
}

/* The 13 trip types — fixed list. Names + descriptions + iconKey.
   Matches the icon set provided by the design team.
   NOTE: This replaces the old chip-style trip-type catalogue. */
const SEED_TRAVEL_TYPES = [
  { id: "tt-bike-packer",   name: "Bike Packer",       icon: "bike-packer",   description: "Multi-day cycling adventures" },
  { id: "tt-comfort",       name: "Comfort",           icon: "comfort",       description: "Adventure with creature comforts" },
  { id: "tt-cultural",      name: "Cultural",          icon: "cultural",      description: "People, places & traditions" },
  { id: "tt-digital-nomad", name: "Digital Nomad",     icon: "digital-nomad", description: "Remote work on the road" },
  { id: "tt-documentary",   name: "Documentary",       icon: "documentary",   description: "Travel with a creative purpose" },
  { id: "tt-expeditionist", name: "Expeditionist",     icon: "expeditionist", description: "Mission-driven, goal-focused trips" },
  { id: "tt-extreme-adv",   name: "Extreme Adventure", icon: "extreme-adv",   description: "Thrill-seeking off-road riding" },
  { id: "tt-hiker",         name: "Hiker",             icon: "hiker",         description: "Travel on foot, trail-focused" },
  { id: "tt-nature",        name: "Nature",            icon: "nature",        description: "Landscapes & wildlife immersion" },
  { id: "tt-overlander",    name: "Overlander",        icon: "overlander",    description: "Self-reliant vehicle journeys" },
  { id: "tt-pathfinder",    name: "Pathfinder",        icon: "pathfinder",    description: "Solo, self-guided exploration" },
  { id: "tt-primitive",     name: "Primitive",         icon: "primitive",     description: "Bare-essentials wilderness travel" },
  { id: "tt-other",         name: "Other",             icon: "other",         description: "Anything that doesn't fit a category" },
];

/* Lookup helper — given a stored trip-type label (e.g. "Hiker"), find the
   matching catalogue entry. Falls back to the "Other" entry so existing
   trips with old type names display the Other icon instead of breaking. */
function getTripType(name) {
  if (!name) return null;
  return SEED_TRAVEL_TYPES.find((tt) => tt.name === name) || SEED_TRAVEL_TYPES.find((tt) => tt.id === "tt-other");
}

/* TripTypeSelect — custom dropdown for picking a trip type.
   Trigger shows current selection (icon + name).
   Open list shows all 13 with descriptions. */
function TripTypeSelect({ value, onChange }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const selected = getTripType(value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" onClick={() => setOpen(!open)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 12,
          padding: "10px 12px", background: C.paper,
          border: `1.5px solid ${C.ink}`, cursor: "pointer", textAlign: "left",
        }}>
        {selected ? (
          <>
            <TripTypeBadge iconKey={selected.icon} size={32} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: F.display, fontSize: 16, fontWeight: 600, color: C.ink }}>
                {selected.name}
              </div>
            </span>
          </>
        ) : (
          <span style={{ flex: 1, fontFamily: F.body, fontSize: 14, color: C.muted }}>
            {t("trips.selectType") || "Select trip type…"}
          </span>
        )}
        <ChevronDown size={16} style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 100,
          background: C.paper, border: `1.5px solid ${C.ink}`,
          maxHeight: 360, overflowY: "auto",
          boxShadow: "0 8px 24px rgba(26,36,33,0.15)",
        }}>
          {SEED_TRAVEL_TYPES.map((tt) => {
            const isSel = selected?.id === tt.id;
            return (
              <button key={tt.id} type="button"
                onClick={() => { onChange(tt.name); setOpen(false); }}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 12px", background: isSel ? C.paperDeep : "transparent",
                  border: "none", borderBottom: `1px solid ${C.line}`, cursor: "pointer", textAlign: "left",
                }}
                onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = C.paperDeep; }}
                onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = "transparent"; }}>
                <TripTypeBadge iconKey={tt.icon} size={36} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: F.display, fontSize: 15, fontWeight: 600, color: C.ink, lineHeight: 1.2 }}>
                    {tt.name}
                  </div>
                  <div style={{ marginTop: 2, fontFamily: F.body, fontSize: 12, color: C.muted, lineHeight: 1.3 }}>
                    {tt.description}
                  </div>
                </span>
                {isSel && <Check size={14} style={{ color: C.rust, flexShrink: 0 }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}


const SEED_ITEMS = [
  { id: "it-1", name: "Down Sleeping Bag", category: "Shelter", weight: "1.2 kg", packed: true },
  { id: "it-2", name: "Merino Base Layer", category: "Apparel", weight: "0.18 kg", packed: true },
  { id: "it-3", name: "Topographic Map", category: "Navigation", weight: "0.04 kg", packed: false },
  { id: "it-4", name: "Titanium Stove", category: "Cooking", weight: "0.32 kg", packed: true },
  { id: "it-5", name: "Headlamp 400lm", category: "Tech", weight: "0.09 kg", packed: false },
  { id: "it-6", name: "Compression Sack", category: "Shelter", weight: "0.07 kg", packed: true },
  { id: "it-7", name: "Trauma Kit", category: "First Aid", weight: "0.45 kg", packed: false },
];
const SEED_TRIPS = [
  { id: "tr-1", name: "Patagonia Traverse", dest: "Torres del Paine, CL", date: "Mar 14 - Mar 28", type: "Alpine Trek" },
  { id: "tr-2", name: "Sahara Crossing", dest: "Erg Chebbi, MA", date: "Oct 02 - Oct 09", type: "Desert Crossing" },
  { id: "tr-3", name: "Inside Passage", dest: "Vancouver Island, CA", date: "Jun 18 - Jun 25", type: "Coastal Kayak" },
];
const SEED_CART = [
  { id: "c-1", name: "Iridium Satellite Beacon", qty: 1 },
  { id: "c-2", name: "Merino Sock 3pk", qty: 2 },
  { id: "c-3", name: "Featherweight Tarp 8x10", qty: 1 },
];
const SEED_KITS = [
  { id: "kit-1", name: "Cold Camp Essentials", category: "Shelter", itemIds: ["it-1", "it-2", "it-6", "it-5"] },
  { id: "kit-2", name: "Day Hike Light", category: "Navigation", itemIds: ["it-3", "it-5", "it-7"] },
];
const SEED_PACKLISTS = [
  {
    id: "pl-1",
    name: "Patagonia 14-Day Trek",
    notes: "Cordillera Darwin. Cold and wet expected. Pack for variable terrain.",
    kitIds: ["kit-1", "kit-2"],
    itemIds: ["it-4"],
  },
  {
    id: "pl-2",
    name: "Weekend Coastal",
    notes: "",
    kitIds: ["kit-2"],
    itemIds: [],
  },
];

// === Mock users registry — used for username search demo ===
// In a real backend these would be remote profiles; here we seed three so
// the username search field has someone to find. Seeded usernames are
// auto-added to takenUsernames so signup doesn't collide with them.
const MOCK_USERS = [
  { username: "amelia",  name: "Amelia Earhart",  region: "NA" },
  { username: "marco",   name: "Marco Polo",      region: "AS" },
  { username: "priya",   name: "Priya Singh",     region: "AS" },
];
const MOCK_USERNAMES_LOWER = MOCK_USERS.map((u) => u.username.toLowerCase());

// Seed inbox — one example pending share so the inbox isn't empty on first run
const SEED_INBOX = [
  {
    id: "in-1",
    fromUsername: "amelia",
    fromName: "Amelia Earhart",
    fromRegion: "NA",
    kind: "kit",                    // "kit" | "category" | "trip"
    mode: "copy",                   // "copy" | "live"
    sentAt: new Date(Date.now() - 86400000 * 2).toISOString(),
    status: "pending",              // "pending" | "imported" | "declined"
    payload: {
      kit: {
        id: "kit-shared-1",
        name: "Alpine Day Pack",
        category: "Navigation",
        itemIds: ["item-shared-a", "item-shared-b", "item-shared-c"],
      },
      items: [
        { id: "item-shared-a", name: "Aluminium Crampons", category: "Navigation", weight: "0.45 kg", quantity: 1, packed: false, consumable: false, expiry: "", remindDays: null },
        { id: "item-shared-b", name: "Glacier Goggles",    category: "Apparel",    weight: "0.10 kg", quantity: 1, packed: false, consumable: false, expiry: "", remindDays: null },
        { id: "item-shared-c", name: "Trekking Poles (pair)", category: "Navigation", weight: "0.55 kg", quantity: 1, packed: false, consumable: false, expiry: "", remindDays: null },
      ],
    },
  },
];

// Generate a memorable share code: "PMD-XXX-XXX" using the rust/forest charset
const generateShareCode = () => {
  const charset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
  const seg = (n) => Array.from({ length: n }, () => charset[Math.floor(Math.random() * charset.length)]).join("");
  return `PMD-${seg(3)}-${seg(3)}`;
};

// Find a user across mock users + the live signed-in user. Used for username search.
const findUserByUsername = (username, currentUser) => {
  if (!username) return null;
  const lower = username.trim().toLowerCase();
  if (currentUser?.username && currentUser.username.toLowerCase() === lower) {
    // The current user is searching for themselves — return them so we can show "can't share with self"
    return { username: currentUser.username, name: currentUser.name, region: currentUser.region, isSelf: true };
  }
  const mock = MOCK_USERS.find((u) => u.username.toLowerCase() === lower);
  if (mock) return mock;
  return null;
};

// === shareService: thin wrapper around inbox writes. Designed to be the
// only file changed when a real backend lands. Today, every operation
// goes through local state setters. Tomorrow, swap each function for an
// API call and the UI doesn't need to change.
const buildShareService = ({ inbox, setInbox, currentUser, items, kits, categories, packlists, trips }) => ({
  /** Send a share via Supabase. Falls back to local inbox if user isn't authenticated. */
  sendShare: async ({ kind, payload, recipientUsername, mode }) => {
    // Self-share rejected up front
    if (currentUser?.username && !recipientUsername.startsWith("code:") &&
        recipientUsername.toLowerCase() === currentUser.username.toLowerCase()) {
      return null;
    }

    // If user is signed in via Supabase, send through the backend
    if (currentUser?.id) {
      const result = await supabaseService.sendShare({
        kind,
        payload,
        recipientUsername,
        mode,
        fromProfile: {
          id: currentUser.id,
          username: currentUser.username,
          name: currentUser.name,
          region: currentUser.region,
        },
      });
      if (result.error) {
        // eslint-disable-next-line no-console
        console.error("Share send failed:", result.error);
        return null;
      }
      // Don't mutate local inbox here — it gets refreshed via fetchInbox
      return result.share;
    }

    // Fallback: localStorage-only (offline / unauthenticated)
    const record = {
      id: uid("sh"),
      fromUsername: currentUser?.username || "anonymous",
      fromName: currentUser?.name || "Anonymous",
      fromRegion: currentUser?.region || "",
      toUsername: recipientUsername,
      kind,
      mode,
      sentAt: new Date().toISOString(),
      status: "pending",
      payload,
    };
    setInbox([record, ...inbox]);
    return record;
  },

  /** Generate an export-friendly JSON payload. */
  exportPayload: ({ kind, payload, mode = "copy" }) => ({
    pakmondoExport: 1,
    kind,
    mode,
    sentAt: new Date().toISOString(),
    fromUsername: currentUser?.username || "anonymous",
    fromName: currentUser?.name || "Anonymous",
    payload,
  }),

  /** Validate + parse an incoming JSON payload from a file. */
  parseImportFile: (text) => {
    try {
      const data = JSON.parse(text);
      if (!data || data.pakmondoExport !== 1) return null;
      if (!["kit", "category", "trip", "location"].includes(data.kind)) return null;
      return {
        id: uid("in"),
        fromUsername: data.fromUsername || "unknown",
        fromName: data.fromName || "Unknown",
        fromRegion: "",
        kind: data.kind,
        mode: data.mode || "copy",
        sentAt: data.sentAt || new Date().toISOString(),
        status: "pending",
        payload: data.payload || {},
      };
    } catch {
      return null;
    }
  },

  /** Mark a share imported (or declined). Goes through Supabase if authenticated. */
  setShareStatus: async (id, status, extras = {}) => {
    if (currentUser?.id && !String(id).startsWith("sh-") && !String(id).startsWith("in-")) {
      // Looks like a Supabase share (not a local fallback record)
      await supabaseService.setShareStatus(id, status, extras);
    }
    // Always update local cache immediately for UI responsiveness
    setInbox(inbox.map((s) => s.id === id ? { ...s, status, ...extras } : s));
  },
});

// Build the payload to send for each entity. Pulls referenced data so
// the recipient has everything they need to make sense of it.
const buildSharePayload = ({ kind, entity, options, items, kits, categories, packlists }) => {
  if (kind === "category") {
    const includeItems = !!options.includeItems;
    const itemsInCat = includeItems ? items.filter((it) => it.category === entity.name) : [];
    return { category: entity, items: itemsInCat };
  }
  if (kind === "kit") {
    // Always send referenced items with a kit — recipient can deselect on import
    const kitItems = entity.itemIds.map((id) => items.find((i) => i.id === id)).filter(Boolean);
    return { kit: entity, items: kitItems };
  }
  if (kind === "trip") {
    const out = { trip: entity, items: [], kits: [], packlist: null };
    if (options.includePacklist || options.includeKits) {
      // Find the packlist matching the trip name (loose link — trips reference
      // packlists by name in this build since they don't yet have an explicit fk)
      const linked = packlists.find((p) => p.name && entity.name && p.name.toLowerCase() === entity.name.toLowerCase());
      if (linked && options.includePacklist) {
        out.packlist = linked;
      }
      if (linked && options.includeKits) {
        const ks = linked.kitIds.map((id) => kits.find((k) => k.id === id)).filter(Boolean);
        out.kits = ks;
        // Include each kit's items too
        const allItemIds = new Set();
        ks.forEach((k) => k.itemIds.forEach((iid) => allItemIds.add(iid)));
        // Add packlist's standalone items
        if (linked) linked.itemIds.forEach((iid) => allItemIds.add(iid));
        out.items = Array.from(allItemIds).map((id) => items.find((i) => i.id === id)).filter(Boolean);
      }
    }
    return out;
  }
  return {};
};

const iconFor = (key) => {
  const map = { tent: Tent, backpack: Backpack, compass: Compass, flame: Flame, tag: Tag, layers: Layers, mountain: Mountain, waves: Waves, snow: Snowflake, tree: TreePine, globe: Globe };
  return map[key] || Backpack;
};

function Header({ go, active, onBack }) {
  const { t } = useI18n();
  const { isMobile } = useViewport();
  const [menuOpen, setMenuOpen] = useState(false);
  const navItems = [["dashboard", t("nav.camp")], ["inventory", t("nav.inventory")], ["packlists", t("nav.packlists")], ["library", t("nav.library")], ["inbox", t("nav.inbox")], ["cart", t("nav.cart")]];

  // Close menu on route change
  useEffect(() => { setMenuOpen(false); }, [active]);

  const goAndClose = (k) => { setMenuOpen(false); go(k); };

  return (
    <>
      <header style={{ position: "relative", zIndex: 20, padding: isMobile ? "14px 16px" : "20px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1.5px solid ${C.ink}`, gap: 12, background: C.paper }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, minWidth: 0, flex: 1 }}>
          {onBack ? (
            <button onClick={onBack} style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", fontFamily: F.mono, fontSize: 11, color: C.ink, letterSpacing: "0.18em", textTransform: "uppercase", padding: 8, marginLeft: -8 }}>
              <ArrowLeft size={14} /> {t("common.back")}
            </button>
          ) : (
            <button onClick={() => go("dashboard")} style={{ display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", cursor: "pointer", padding: 0, minWidth: 0 }}>
              <Logo size={isMobile ? "headerMobile" : "header"} />
            </button>
          )}
          {/* Slogan — shown on desktop on every screen EXCEPT the dashboard
              (where the same slogan appears centered in the hero) and back-pages
              (where the back button replaces the logo). On mobile the header is
              too tight, so the slogan still appears on dashboard hero only. */}
          {!isMobile && !onBack && active !== "dashboard" && (
            <span style={{
              fontFamily: F.display, fontStyle: "italic",
              fontSize: 14, color: C.inkSoft,
              borderLeft: `1px solid ${C.line}`,
              paddingLeft: 14, marginLeft: 4,
              whiteSpace: "nowrap",
            }}>
              {t("brand.tagline")}
            </span>
          )}
        </div>

        {!isMobile && (
          <nav style={{ display: "flex", alignItems: "center", gap: 28, flexWrap: "wrap" }}>
            {navItems.map(([k, l]) => (
              <button key={k} onClick={() => go(k)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: F.mono, fontSize: 11, letterSpacing: "0.2em", textTransform: "uppercase", color: active === k ? C.rust : C.ink, fontWeight: active === k ? 700 : 500 }}>
                {l}
              </button>
            ))}
          </nav>
        )}

        <div style={{ display: "flex", gap: isMobile ? 4 : 12, alignItems: "center" }}>
          {!isMobile && (
            <button onClick={() => go("cart")} style={{ padding: 8, background: "none", border: "none", cursor: "pointer", color: C.ink }} aria-label={t("nav.cart")}><ShoppingCart size={18} /></button>
          )}
          <button onClick={() => go("settings")} style={{ padding: isMobile ? 10 : 8, background: "none", border: "none", cursor: "pointer", color: C.ink, minWidth: 44, minHeight: 44, display: "inline-flex", alignItems: "center", justifyContent: "center" }} aria-label={t("set.title")}>
            <Settings size={isMobile ? 22 : 18} />
          </button>
          {isMobile && !onBack && (
            <button onClick={() => setMenuOpen(true)} style={{ padding: 10, background: "none", border: "none", cursor: "pointer", color: C.ink, minWidth: 44, minHeight: 44, display: "inline-flex", alignItems: "center", justifyContent: "center" }} aria-label="Open menu">
              <Menu size={24} />
            </button>
          )}
        </div>
      </header>

      {/* Mobile drawer overlay */}
      {isMobile && menuOpen && (
        <div
          onClick={() => setMenuOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(26,36,33,0.5)", zIndex: 100, animation: "none" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "absolute", top: 0, right: 0, bottom: 0,
              width: "min(82vw, 320px)",
              background: C.paper,
              borderLeft: `1.5px solid ${C.ink}`,
              padding: "20px 20px 24px",
              display: "flex", flexDirection: "column",
              boxShadow: "-2px 0 12px rgba(26,36,33,0.18)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28, paddingBottom: 16, borderBottom: `1.5px dashed ${C.line}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Logo size="headerMobile" />
              </div>
              <button onClick={() => setMenuOpen(false)} style={{ width: 38, height: 38, background: "transparent", border: "none", cursor: "pointer", color: C.ink, display: "inline-flex", alignItems: "center", justifyContent: "center" }} aria-label="Close menu">
                <X size={20} />
              </button>
            </div>

            <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {navItems.map(([k, l]) => {
                const sel = active === k;
                return (
                  <button
                    key={k}
                    onClick={() => goAndClose(k)}
                    style={{
                      textAlign: "left",
                      padding: "16px 14px",
                      background: sel ? C.ink : "transparent",
                      color: sel ? C.paper : C.ink,
                      border: "none",
                      cursor: "pointer",
                      fontFamily: F.mono,
                      fontSize: 13,
                      letterSpacing: "0.18em",
                      textTransform: "uppercase",
                      fontWeight: 700,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <span>{l}</span>
                    {sel && <ChevronRight size={16} />}
                  </button>
                );
              })}
            </nav>

            <div style={{ marginTop: 28, paddingTop: 20, borderTop: `1.5px dashed ${C.line}` }}>
              <button
                onClick={() => goAndClose("settings")}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "14px",
                  background: "transparent",
                  border: `1.5px solid ${C.ink}`,
                  cursor: "pointer",
                  fontFamily: F.mono,
                  fontSize: 12,
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  fontWeight: 700,
                  color: C.ink,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <Settings size={16} /> {t("set.title")}
              </button>
            </div>

            <div style={{ marginTop: "auto", paddingTop: 24, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", textAlign: "center" }}>
              {t("brand.tagline")}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Footer() {
  const { t } = useI18n();
  const { isMobile } = useViewport();
  return (
    <footer style={{
      marginTop: isMobile ? 32 : 40,
      padding: isMobile ? "20px 16px" : "32px",
      display: "flex",
      flexDirection: isMobile ? "column" : "row",
      justifyContent: "space-between",
      alignItems: isMobile ? "flex-start" : "baseline",
      flexWrap: "wrap",
      gap: isMobile ? 8 : 16,
      borderTop: `1.5px dashed ${C.line}`,
    }}>
      <Coord>PAKMONDO PMD 47.6062N 122.3321W</Coord>
      <a
        href="mailto:pakmondoapp@gmail.com"
        style={{
          fontFamily: F.mono, fontSize: 11, color: C.muted,
          letterSpacing: "0.05em", textDecoration: "none",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = C.rust; e.currentTarget.style.textDecoration = "underline"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = C.muted; e.currentTarget.style.textDecoration = "none"; }}
      >
        {t("footer.contact")}
      </a>
      <Coord>{t("brand.tagline")}</Coord>
    </footer>
  );
}

function Welcome({ go }) {
  const { t } = useI18n();
  const { isMobile, isNarrow } = useViewport();
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", position: "relative" }}>
      <TopoBG opacity={0.18} />
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: isMobile ? "48px 20px" : "80px 24px", position: "relative", zIndex: 10 }}>
        <div style={{ maxWidth: 720, textAlign: "center", width: "100%" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: isMobile ? 24 : 32 }}>
            <Stamp rotate={-6}>{t("brand.fieldTested")}</Stamp>
          </div>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
            <CompassRose size={isMobile ? 48 : 60} />
          </div>
          <div style={{ display: "flex", justifyContent: "center", margin: "0 0 20px 0" }}>
            <div style={{ width: "100%", maxWidth: isMobile ? 280 : 480 }}>
              <img src={LOGO_DATA_URL} alt="PakMondo" style={{ width: "100%", height: "auto", display: "block" }} />
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16, marginBottom: 24 }}>
            <div style={{ width: isMobile ? 60 : 96 }}><DashLine /></div>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.rust }} />
            <div style={{ width: isMobile ? 60 : 96 }}><DashLine /></div>
          </div>
          <p style={{ fontFamily: F.display, fontStyle: "italic", fontSize: isMobile ? 18 : 22, color: C.inkSoft, margin: "0 0 12px 0", padding: "0 8px" }}>
            {t("brand.tagline")}
          </p>
          <p style={{ fontFamily: F.mono, fontSize: isNarrow ? 10 : 11, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", margin: "0 0 40px 0" }}>
            {t("brand.subline")}
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", flexDirection: isMobile ? "column" : "row" }}>
            <Btn onClick={() => go("login")} variant="primary" icon={Lock} fullWidth={isMobile}>{t("welcome.signIn")}</Btn>
            <Btn onClick={() => go("signup")} variant="ghost" icon={Plus} fullWidth={isMobile}>{t("welcome.createAccount")}</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

function Login({ go, setUser }) {
  const { t } = useI18n();
  const { isMobile } = useViewport();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (submitting || !email.trim() || !pw) return;
    setSubmitting(true);
    setError("");
    const result = await supabaseService.signIn({ email: email.trim(), password: pw });
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setUser({
      id: result.user.id,
      name: result.profile?.name || email.split("@")[0],
      email: result.user.email,
      username: result.profile?.username || "",
      region: result.profile?.region || "",
      is_admin: !!result.profile?.is_admin,
    });
    go("dashboard");
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "32px 20px" }}>
      <div style={{ width: "100%", maxWidth: 440 }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
          <div style={{ width: "100%", maxWidth: 280 }}>
            <img src={LOGO_DATA_URL} alt="PakMondo" style={{ width: "100%", height: "auto", display: "block" }} />
          </div>
        </div>
        <button onClick={() => go("welcome")} style={{ marginBottom: 36, display: "inline-flex", alignItems: "center", gap: 8, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer", padding: "8px 0" }}>
          <ArrowLeft size={14} /> {t("common.back")}
        </button>
        <Stamp rotate={-4} color={C.forest}>{t("login.stamp")}</Stamp>
        <h2 style={{ margin: "20px 0 8px 0", fontFamily: F.display, fontSize: "clamp(40px, 10vw, 56px)", fontWeight: 700, lineHeight: 1, letterSpacing: "-0.02em" }}>
          {t("login.title")}<span style={{ color: C.rust }}>.</span>
        </h2>
        <p style={{ fontFamily: F.display, fontStyle: "italic", color: C.muted, fontSize: 18, margin: "0 0 32px 0" }}>{t("login.sub")}</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <Field label={t("login.email")} icon={Mail} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="explorer@pakmondo.co" />
          <Field label={t("login.password")} icon={Lock} type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="********" />
        </div>
        {error && (
          <div style={{ marginTop: 16, padding: 12, background: C.paperDeep, border: `1.5px solid ${C.rust}`, color: C.rust, fontFamily: F.body, fontSize: 13 }}>
            {error}
          </div>
        )}
        <div style={{ marginTop: 32, display: "flex", flexDirection: isMobile ? "column" : "row", justifyContent: "space-between", alignItems: isMobile ? "stretch" : "center", gap: 16 }}>
          <Btn onClick={submit} variant="primary" icon={ChevronRight} fullWidth={isMobile} disabled={submitting}>
            {submitting ? "..." : t("login.submit")}
          </Btn>
          <button onClick={() => go("signup")} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: F.body, fontSize: 13, color: C.muted, textDecoration: "underline", padding: "10px 0", textAlign: isMobile ? "center" : "right" }}>
            {t("login.noAccount")}
          </button>
        </div>
        <div style={{ marginTop: 12, textAlign: isMobile ? "center" : "left" }}>
          <button onClick={() => go("forgot")} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: F.body, fontSize: 12, color: C.muted, textDecoration: "underline", padding: "6px 0" }}>
            {t("login.forgotPassword")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   FORGOT PASSWORD — request reset email screen.
   User enters email → Supabase emails them a link → they land
   on the reset screen via /?reset=true.
   ============================================================ */
function ForgotPassword({ go }) {
  const { t } = useI18n();
  const { isMobile } = useViewport();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!email.trim() || submitting) return;
    setSubmitting(true);
    setError("");
    const result = await supabaseService.resetPasswordForEmail(email.trim());
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setSent(true);
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "32px 20px" }}>
      <div style={{ width: "100%", maxWidth: 440 }}>
        <button onClick={() => go("login")} style={{ marginBottom: 36, display: "inline-flex", alignItems: "center", gap: 8, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer", padding: "8px 0" }}>
          <ArrowLeft size={14} /> {t("fp.backToLogin")}
        </button>

        {!sent ? (
          <>
            <h2 style={{ margin: "20px 0 8px 0", fontFamily: F.display, fontSize: "clamp(36px, 9vw, 52px)", fontWeight: 700, lineHeight: 1, letterSpacing: "-0.02em" }}>
              {t("fp.title")} <span style={{ fontStyle: "italic", color: C.forest }}>{t("fp.title2")}</span><span style={{ color: C.rust }}>.</span>
            </h2>
            <p style={{ fontFamily: F.display, fontStyle: "italic", color: C.muted, fontSize: 17, margin: "0 0 32px 0" }}>{t("fp.sub")}</p>
            <Field label={t("fp.emailLabel")} icon={Mail} value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("fp.emailPh")} />
            {error && (
              <div style={{ marginTop: 16, padding: 12, background: C.paperDeep, border: `1.5px solid ${C.rust}`, color: C.rust, fontFamily: F.body, fontSize: 13 }}>
                {error}
              </div>
            )}
            <div style={{ marginTop: 32 }}>
              <Btn onClick={submit} variant="rust" icon={ChevronRight} fullWidth={true} disabled={submitting || !email.trim()}>
                {submitting ? "..." : t("fp.send")}
              </Btn>
            </div>
          </>
        ) : (
          <>
            <h2 style={{ margin: "20px 0 8px 0", fontFamily: F.display, fontSize: "clamp(36px, 9vw, 52px)", fontWeight: 700, lineHeight: 1, letterSpacing: "-0.02em" }}>
              {t("fp.sent")}<span style={{ color: C.rust }}>.</span>
            </h2>
            <p style={{ fontFamily: F.display, fontStyle: "italic", color: C.muted, fontSize: 16, margin: "16px 0 32px 0", lineHeight: 1.5 }}>{t("fp.sentSub")}</p>
            <Btn onClick={() => go("login")} variant="ghost" icon={ArrowLeft} fullWidth={true}>
              {t("fp.backToLogin")}
            </Btn>
          </>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   RESET PASSWORD — page user lands on after clicking the email link.
   They have a temporary post-recovery session active; we just need
   to update their password.
   ============================================================ */
function ResetPassword({ go }) {
  const { t } = useI18n();
  const { isMobile } = useViewport();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const validate = () => {
    if (pw.length < 6) return t("fp.tooShort");
    if (pw !== pw2) return t("fp.mismatch");
    return null;
  };

  const submit = async () => {
    const v = validate();
    if (v) { setError(v); return; }
    setSubmitting(true);
    setError("");
    const result = await supabaseService.updatePassword(pw);
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    // Clear the post-recovery session so they have to sign in cleanly
    await supabaseService.signOut();
    setDone(true);
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "32px 20px" }}>
      <div style={{ width: "100%", maxWidth: 440 }}>
        {!done ? (
          <>
            <h2 style={{ margin: "20px 0 8px 0", fontFamily: F.display, fontSize: "clamp(36px, 9vw, 52px)", fontWeight: 700, lineHeight: 1, letterSpacing: "-0.02em" }}>
              {t("fp.newTitle")} <span style={{ fontStyle: "italic", color: C.forest }}>{t("fp.newTitle2")}</span><span style={{ color: C.rust }}>.</span>
            </h2>
            <p style={{ fontFamily: F.display, fontStyle: "italic", color: C.muted, fontSize: 17, margin: "0 0 32px 0" }}>{t("fp.newSub")}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              <Field label={t("fp.newPwLabel")} icon={Lock} type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={t("fp.newPwPh")} />
              <Field label={t("fp.confirmPwLabel")} icon={Lock} type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder={t("fp.confirmPwPh")} />
            </div>
            {error && (
              <div style={{ marginTop: 16, padding: 12, background: C.paperDeep, border: `1.5px solid ${C.rust}`, color: C.rust, fontFamily: F.body, fontSize: 13 }}>
                {error}
              </div>
            )}
            <div style={{ marginTop: 32 }}>
              <Btn onClick={submit} variant="rust" icon={ChevronRight} fullWidth={true} disabled={submitting || !pw || !pw2}>
                {submitting ? "..." : t("fp.update")}
              </Btn>
            </div>
          </>
        ) : (
          <>
            <h2 style={{ margin: "20px 0 8px 0", fontFamily: F.display, fontSize: "clamp(36px, 9vw, 52px)", fontWeight: 700, lineHeight: 1, letterSpacing: "-0.02em" }}>
              <span style={{ fontStyle: "italic", color: C.forest }}>{t("fp.updated").split(".")[0]}</span><span style={{ color: C.rust }}>.</span>
            </h2>
            <p style={{ fontFamily: F.display, fontStyle: "italic", color: C.muted, fontSize: 16, margin: "16px 0 32px 0", lineHeight: 1.5 }}>{t("fp.updated")}</p>
            <Btn onClick={() => go("login")} variant="rust" icon={ChevronRight} fullWidth={true}>
              {t("login.submit")}
            </Btn>
          </>
        )}
      </div>
    </div>
  );
}

// Username validation: letters, digits, dot, underscore, hyphen — 2 to 20 chars
const USERNAME_RE = /^[A-Za-z0-9._-]{2,20}$/;

// Derive a sensible default username from a person's full name.
// "Amelia Earhart" -> "amelia"; "  Jose María  " -> "jose"
const deriveUsernameFromName = (name) => {
  if (!name) return "";
  const first = name.trim().split(/\s+/)[0] || "";
  return first.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]/g, "");
};

function Signup({ go, setUser, takenUsernames, setTakenUsernames }) {
  const { t, lang } = useI18n();
  const { isMobile } = useViewport();
  const [form, setForm] = useState({
    name: "",
    username: "",
    usernameDirty: false, // whether the user has manually edited the username
    email: "",
    pw: "",
    region: "",
  });

  const set = (k) => (e) => {
    const value = e.target.value;
    if (k === "name") {
      // Auto-fill username from name unless the user has already typed a custom one
      setForm((f) => ({
        ...f,
        name: value,
        username: f.usernameDirty ? f.username : deriveUsernameFromName(value),
      }));
    } else if (k === "username") {
      setForm((f) => ({ ...f, username: value, usernameDirty: true }));
    } else {
      setForm((f) => ({ ...f, [k]: value }));
    }
  };

  // Derive validation state for the username field — runs every render
  const usernameTrimmed = form.username.trim();
  const usernameLower = usernameTrimmed.toLowerCase();
  const takenSet = takenUsernames.map((u) => u.toLowerCase());
  let usernameStatus = null; // null | "invalid" | "taken" | "available"
  if (usernameTrimmed.length > 0) {
    if (!USERNAME_RE.test(usernameTrimmed)) {
      usernameStatus = "invalid";
    } else if (takenSet.includes(usernameLower)) {
      usernameStatus = "taken";
    } else {
      usernameStatus = "available";
    }
  }
  const formValid = form.name.trim() && form.email.trim() && form.pw.length >= 6 && usernameStatus === "available" && form.region;

  // Supabase-backed signup state
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const submit = async () => {
    if (!formValid || submitting) return;
    setSubmitting(true);
    setSubmitError("");
    const finalUsername = usernameTrimmed;
    const finalName = form.name.trim() || t("dash.wayfarer");
    const result = await supabaseService.signUp({
      email: form.email.trim(),
      password: form.pw,
      username: finalUsername,
      name: finalName,
      region: form.region,
    });
    setSubmitting(false);
    if (result.error) {
      setSubmitError(result.error);
      return;
    }
    setUser({
      id: result.user.id,
      name: finalName,
      email: form.email.trim(),
      username: finalUsername,
      region: form.region,
    });
    setTakenUsernames([...takenUsernames, finalUsername]);
    go("dashboard");
  };

  // Helper text + color for the username field's status line
  const statusColor = usernameStatus === "available" ? C.forest
    : usernameStatus === "taken" ? C.rust
    : usernameStatus === "invalid" ? C.rust
    : C.muted;
  const statusText = usernameStatus === "available" ? t("signup.usernameAvailable")
    : usernameStatus === "taken" ? t("signup.usernameTaken")
    : usernameStatus === "invalid" ? t("signup.usernameInvalid")
    : t("signup.usernameHint");

  return (
    <div style={{ padding: "32px 20px", maxWidth: 1100, margin: "0 auto" }}>
      <button onClick={() => go("welcome")} style={{ marginBottom: 32, display: "inline-flex", alignItems: "center", gap: 8, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer", padding: "8px 0" }}>
        <ArrowLeft size={14} /> {t("common.back")}
      </button>
      <Stamp rotate={-5} color={C.rust}>{t("signup.stamp")}</Stamp>
      <h2 style={{ margin: "20px 0 8px 0", fontFamily: F.display, fontSize: "clamp(40px, 9vw, 56px)", fontWeight: 700, lineHeight: 0.95, letterSpacing: "-0.03em" }}>
        {t("signup.title1")}<br /><span style={{ fontStyle: "italic", color: C.forest }}>{t("signup.title2")}</span>
      </h2>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(320px, 1fr))", gap: isMobile ? 36 : 48, marginTop: isMobile ? 32 : 48 }}>
        <div>
          <SectionHeader num="01" label={t("signup.identity")} right={t("signup.required")} />
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <Field label={t("signup.fullName")} icon={User} value={form.name} onChange={set("name")} placeholder="Amelia Earhart" />

            {/* USERNAME with live availability indicator */}
            <div>
              <Field
                label={t("signup.username")}
                icon={Tag}
                value={form.username}
                onChange={set("username")}
                placeholder={t("signup.usernamePh")}
              />
              <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6, fontFamily: F.mono, fontSize: 11, color: statusColor, letterSpacing: "0.05em", fontStyle: usernameStatus ? "normal" : "italic" }}>
                {usernameStatus === "available" && <Check size={12} strokeWidth={3} />}
                {(usernameStatus === "taken" || usernameStatus === "invalid") && <X size={12} strokeWidth={3} />}
                <span>{statusText}</span>
              </div>
            </div>

            {/* REGION dropdown */}
            <div>
              <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
                <Globe size={11} /> {t("signup.region")}
              </div>
              <select
                value={form.region}
                onChange={set("region")}
                style={{
                  width: "100%",
                  padding: "10px 28px 10px 0",
                  background: "transparent",
                  border: "none",
                  borderBottom: `1.5px solid ${C.ink}`,
                  outline: "none",
                  fontFamily: F.body,
                  fontSize: 16,
                  color: form.region ? C.ink : C.muted,
                  appearance: "none",
                  WebkitAppearance: "none",
                  MozAppearance: "none",
                  backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%231A2421' stroke-width='1.5' fill='none'/></svg>")`,
                  backgroundRepeat: "no-repeat",
                  backgroundPosition: "right 4px center",
                  cursor: "pointer",
                }}
              >
                <option value="">{t("signup.regionPlaceholder")}</option>
                {REGIONS.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.code} — {lang === "es" ? r.labelEs : r.labelEn}
                  </option>
                ))}
              </select>
              {/* Preview the selected badge */}
              {form.region && (
                <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
                  <RegionBadge code={form.region} size="detail" />
                  <span style={{ fontFamily: F.body, fontSize: 14, color: C.ink }}>{regionLabel(form.region, lang)}</span>
                </div>
              )}
              {!form.region && (
                <div style={{ marginTop: 6, fontFamily: F.body, fontSize: 11, color: C.muted, fontStyle: "italic" }}>
                  {t("signup.regionHint")}
                </div>
              )}
            </div>

            <Field label={t("login.email")} icon={Mail} type="email" value={form.email} onChange={set("email")} placeholder="amelia@pakmondo.co" />
            <Field label={t("login.password")} icon={Lock} type="password" value={form.pw} onChange={set("pw")} placeholder={t("signup.passwordHint")} />
          </div>
        </div>
      </div>
      <div style={{ marginTop: isMobile ? 36 : 56, display: "flex", flexDirection: "column", gap: 12, alignItems: isMobile ? "stretch" : "flex-end" }}>
        {submitError && (
          <div style={{ padding: 12, background: C.paperDeep, border: `1.5px solid ${C.rust}`, color: C.rust, fontFamily: F.body, fontSize: 13, width: "100%" }}>
            {submitError}
          </div>
        )}
        <Btn onClick={submit} variant="rust" icon={ChevronRight} fullWidth={isMobile} disabled={!formValid || submitting}>
          {submitting ? "..." : t("signup.submit")}
        </Btn>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }) {
  const { isMobile } = useViewport();
  return (
    <div style={{ padding: isMobile ? 16 : 24, background: C.paper }}>
      <div style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: C.muted }}>{label}</div>
      <div style={{ marginTop: 8, fontFamily: F.display, fontSize: isMobile ? 30 : 40, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1 }}>{value}</div>
      <div style={{ marginTop: 4, fontFamily: F.body, fontSize: 12, color: C.inkSoft }}>{sub}</div>
    </div>
  );
}

function NavCard({ num, title, tagline, icon: Icon, onClick, dark, accent, badge }) {
  const { isMobile } = useViewport();
  const bg = dark ? C.ink : accent ? C.rust : C.paper;
  const fg = dark || accent ? C.paper : C.ink;
  return (
    <button onClick={onClick} style={{ padding: isMobile ? 20 : 32, textAlign: "left", position: "relative", cursor: "pointer", background: bg, color: fg, minHeight: isMobile ? 180 : 280, border: "none", width: "100%" }}>
      {badge > 0 && (
        <div style={{ position: "absolute", top: 12, right: 12 }}>
          <AlertBadge count={badge} size={isMobile ? 22 : 26} />
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: "0.2em", opacity: 0.7 }}>{num}</div>
        <Icon size={isMobile ? 22 : 26} strokeWidth={1.5} style={{ marginRight: badge > 0 ? 32 : 0 }} />
      </div>
      <div style={{ marginTop: isMobile ? 32 : 64, fontFamily: F.display, fontSize: isMobile ? 28 : 38, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 0.95 }}>{title}</div>
      <div style={{ marginTop: 10, maxWidth: 240, fontFamily: F.display, fontStyle: "italic", fontSize: isMobile ? 14 : 16, opacity: 0.85 }}>{tagline}</div>
    </button>
  );
}

function Dashboard({ go, user, trips, cart, items, packlists = [], kits = [], locationEnabled, shareService }) {
  const { t, locale, lang, units } = useI18n();
  const { isMobile } = useViewport();
  const totalKgRaw = items.filter((i) => i.packed).reduce((s, i) => s + parseKg(i.weight || ""), 0);
  const totalWeight = formatWeightFromKg(totalKgRaw, units);

  const [coords, setCoords] = useState(null);
  const [coordsState, setCoordsState] = useState("idle");
  const [place, setPlace] = useState(null);                 // reverse-geocoded result
  const [placeState, setPlaceState] = useState("idle");     // "idle" | "loading" | "ok" | "error"

  // Fetch the device's current location. Called automatically when
  // locationEnabled flips on, AND on demand via the Refresh button.
  const fetchLocation = (manual = false) => {
    if (!locationEnabled) {
      setCoords(null); setCoordsState("idle"); return;
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setCoordsState("unsupported"); return;
    }
    setCoordsState("pending");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setCoordsState("ok");
      },
      (err) => {
        setCoordsState(err && err.code === 1 ? "denied" : "unavailable");
      },
      { timeout: 8000, maximumAge: manual ? 0 : 60000, enableHighAccuracy: false }
    );
  };

  useEffect(() => {
    fetchLocation(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationEnabled]);

  // Whenever coords change, kick off a reverse-geocode lookup.
  useEffect(() => {
    if (!coords) { setPlace(null); setPlaceState("idle"); return; }
    let cancelled = false;
    setPlaceState("loading");
    reverseGeocode(coords.lat, coords.lon, lang).then((res) => {
      if (cancelled) return;
      if (res) { setPlace(res); setPlaceState("ok"); }
      else     { setPlace(null); setPlaceState("error"); }
    });
    return () => { cancelled = true; };
  }, [coords?.lat, coords?.lon, lang]);

  const fmtCoord = (val, posLetter, negLetter) => {
    const abs = Math.abs(val).toFixed(4);
    return `${abs} ${val >= 0 ? posLetter : negLetter}`;
  };

  const coordLine =
    coordsState === "idle" ? t("dash.locOff")
    : coordsState === "pending" ? t("dash.locPending")
    : coordsState === "ok" && coords ? `${fmtCoord(coords.lat, "N", "S")}  /  ${fmtCoord(coords.lon, "E", "W")}`
    : coordsState === "denied" ? t("dash.locDenied")
    : coordsState === "unsupported" ? t("dash.locUnsupported")
    : t("dash.locUnknown");

  const alerts = getExpiryAlerts(items);
  const fmtAlertDate = (iso) => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(locale, { month: "short", day: "2-digit", year: "numeric" });
  };

  return (
    <div>
      <Header go={go} active="dashboard" />
      <div style={{ padding: padX(isMobile), position: "relative" }}>
        <TopoBG opacity={0.08} />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div style={{ marginTop: isMobile ? 24 : 40 }}>
            <Coord>{t("dash.basecamp")}</Coord>
            <h1 style={{ margin: "12px 0 6px", fontFamily: F.display, fontSize: "clamp(36px, 6vw, 80px)", fontWeight: 700, lineHeight: 0.95, letterSpacing: "-0.03em", fontStyle: "italic", color: C.forest, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span>
                {user.username || user.name || t("dash.wayfarer")}<span style={{ color: C.rust, fontStyle: "normal" }}>.</span>
              </span>
              {user.region && (
                <span style={{ display: "inline-flex", alignItems: "center", verticalAlign: "middle" }}>
                  <RegionBadge code={user.region} />
                </span>
              )}
              {alerts.length > 0 && (
                <button
                  onClick={() => go("inventory", { filter: "expiring" })}
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
                  aria-label={`${alerts.length} alerts`}
                >
                  <AlertBadge count={alerts.length} size={32} />
                </button>
              )}
            </h1>
            <div style={{ marginBottom: 14, fontFamily: F.mono, fontSize: 11, letterSpacing: "0.18em", color: C.muted, textTransform: "uppercase" }}>
              {coordLine}
            </div>
            <DashLine />
            <p style={{ marginTop: 14, marginBottom: 0, fontFamily: F.display, fontStyle: "italic", fontSize: isMobile ? 16 : 19, color: C.inkSoft, textAlign: "center" }}>
              {t("brand.tagline")}
            </p>
          </div>

          {/* === LOCATION CARD === */}
          <div style={{ marginTop: isMobile ? 14 : 18, padding: isMobile ? 10 : 12, background: C.paper, border: `1.5px solid ${C.ink}`, position: "relative" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ width: 28, height: 28, flexShrink: 0, background: C.forest, color: C.paper, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                <MapPin size={14} strokeWidth={1.6} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 700 }}>
                  {t("loc.cardTitle")}
                </div>
                {coordsState === "ok" && coords ? (
                  <>
                    <div style={{ marginTop: 2, fontFamily: F.display, fontSize: isMobile ? 14 : 16, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1, color: C.ink, wordBreak: "break-word" }}>
                      {formatCoords(coords.lat, coords.lon)}
                    </div>
                    <div style={{ marginTop: 2, fontFamily: F.body, fontSize: isMobile ? 11 : 12, fontStyle: "italic", color: C.inkSoft, minHeight: 16 }}>
                      {placeState === "loading" ? t("loc.placeLoading")
                       : placeState === "ok" && place?.full ? place.full
                       : placeState === "error" ? t("loc.placeUnknown")
                       : ""}
                    </div>
                  </>
                ) : (
                  <div style={{ marginTop: 2, fontFamily: F.body, fontSize: 12, color: C.inkSoft, fontStyle: "italic" }}>
                    {coordLine}
                  </div>
                )}
              </div>
            </div>

            {/* Action buttons — refresh + open in Google Maps only */}
            <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
              <button onClick={() => fetchLocation(true)}
                style={{ padding: "5px 9px", background: "transparent", border: `1.5px solid ${C.ink}`, color: C.ink, cursor: "pointer", fontFamily: F.mono, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}>
                ↻ {t("loc.refresh")}
              </button>
              {coordsState === "ok" && coords && (
                <a href={googleMapsUrl(coords.lat, coords.lon)} target="_blank" rel="noopener noreferrer"
                  style={{ padding: "5px 9px", background: C.rust, border: `1.5px solid ${C.rust}`, color: C.paper, textDecoration: "none", cursor: "pointer", fontFamily: F.mono, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}>
                  🗺 {t("loc.openMaps")}
                </a>
              )}
            </div>
          </div>

          {alerts.length > 0 && (
            <div style={{ marginTop: 32, padding: 24, background: C.paperDeep, border: `1.5px solid ${C.rust}`, position: "relative" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
                <AlertBadge count={alerts.length} size={28} />
                <div>
                  <div style={{ fontFamily: F.mono, fontSize: 10, color: C.rust, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 700 }}>
                    {t("dash.attentionRequired")}
                  </div>
                  <div style={{ fontFamily: F.display, fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", color: C.ink }}>
                    {alerts.length === 1 ? t("dash.itemsNeedReview_one") : t("dash.itemsNeedReview_many", { count: alerts.length })}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
                {alerts.slice(0, 5).map((it) => {
                  const d = daysUntil(it.expiry);
                  const status =
                    d == null ? ""
                    : d < 0 ? (Math.abs(d) === 1 ? t("dash.expiredAgo_one") : t("dash.expiredAgo_many", { n: Math.abs(d) }))
                    : d === 0 ? t("dash.expiresToday")
                    : (d === 1 ? t("dash.expiresInDays_one") : t("dash.expiresInDays_many", { n: d }));
                  return (
                    <div key={it.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "8px 0", borderBottom: `1px dashed ${C.line}` }}>
                      <div>
                        <span style={{ fontFamily: F.display, fontSize: 16, fontWeight: 600, color: C.ink }}>{it.name}</span>
                        <span style={{ marginLeft: 10, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.05em" }}>
                          {tOrLiteral(lang, "cat", it.category)}  /  {fmtAlertDate(it.expiry)}
                        </span>
                      </div>
                      <span style={{ fontFamily: F.mono, fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: d != null && d < 0 ? C.rust : C.ochre }}>
                        {status}
                      </span>
                    </div>
                  );
                })}
                {alerts.length > 5 && (
                  <div style={{ marginTop: 4, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                    {t("dash.moreInInventory", { n: alerts.length - 5 })}
                  </div>
                )}
              </div>
              <div style={{ marginTop: 16 }}>
                <Btn variant="rust" icon={ChevronRight} onClick={() => go("inventory", { filter: "expiring" })}>{t("dash.reviewExpiring")}</Btn>
              </div>
            </div>
          )}

          <h2 style={{ marginTop: isMobile ? 48 : 80, marginBottom: isMobile ? 20 : 32, fontFamily: F.display, fontSize: isMobile ? 26 : 32, fontWeight: 700, letterSpacing: "-0.02em" }}>{t("dash.kitTitle")}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 1, background: C.line }}>
            <NavCard num="01" title={t("dash.navInventory")} tagline={t("dash.navInventoryTag")} icon={Backpack} onClick={() => go("inventory")} dark badge={alerts.length} />
            <NavCard num="02" title={t("dash.navPacklists")} tagline={t("dash.navPacklistsTag")} icon={MapIcon} onClick={() => go("packlists")} />
            <NavCard num="03" title={t("dash.navCart")} tagline={t("dash.navCartTag")} icon={ShoppingCart} onClick={() => go("cart")} accent />
          </div>
          <h2 style={{ marginTop: isMobile ? 48 : 80, marginBottom: isMobile ? 20 : 32, fontFamily: F.display, fontSize: isMobile ? 26 : 32, fontWeight: 700, letterSpacing: "-0.02em" }}>{t("dash.savedPacklists")}</h2>
          {packlists.length === 0 ? (
            <div style={{ padding: isMobile ? 24 : 32, background: C.paperDeep, border: `1.5px dashed ${C.line}`, textAlign: "center" }}>
              <div style={{ fontFamily: F.display, fontStyle: "italic", fontSize: isMobile ? 18 : 22, color: C.inkSoft }}>{t("dash.noPacklists")}</div>
              <div style={{ marginTop: 6, marginBottom: 18, fontFamily: F.mono, fontSize: 11, letterSpacing: "0.15em", color: C.muted, textTransform: "uppercase" }}>{t("dash.noPacklistsHint")}</div>
              <Btn variant="rust" icon={Plus} onClick={() => go("packlists")} fullWidth={isMobile}>{t("dash.composePacklist")}</Btn>
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: 12 }}>
                {packlists.slice(0, 3).map((p) => {
                  const kCount = p.kitIds.length;
                  const iCount = p.itemIds.length;
                  // Total unique items across kits + standalone
                  const idSet = new Set();
                  p.kitIds.forEach((kid) => {
                    const k = kits.find((kk) => kk.id === kid);
                    if (k) k.itemIds.forEach((iid) => idSet.add(iid));
                  });
                  p.itemIds.forEach((iid) => idSet.add(iid));
                  const totalUnique = idSet.size;
                  return (
                    <button
                      key={p.id}
                      onClick={() => go("packlists")}
                      style={{
                        padding: isMobile ? 14 : 18,
                        background: C.paper,
                        border: `1.5px solid ${C.ink}`,
                        cursor: "pointer",
                        textAlign: "left",
                        fontFamily: F.body,
                        color: C.ink,
                      }}
                    >
                      <Coord>PACKLIST</Coord>
                      <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 10 }}>
                        {p.type && <TripTypeBadge iconKey={getTripType(p.type)?.icon || "other"} size={isMobile ? 32 : 36} />}
                        <div style={{ flex: 1, minWidth: 0, fontFamily: F.display, fontSize: isMobile ? 18 : 20, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1 }}>
                          {p.name}
                        </div>
                      </div>
                      <div style={{ marginTop: 8, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                        {kCount === 1 ? t("pl.kitsCount_one") : t("pl.kitsCount_many", { n: kCount })}
                        {iCount > 0 && ` / ${iCount === 1 ? t("pl.itemsCount_one") : t("pl.itemsCount_many", { n: iCount })}`}
                        {totalUnique > 0 && ` / ${t("pl.totalUnique", { n: totalUnique })}`}
                      </div>
                    </button>
                  );
                })}
              </div>
              <div style={{ marginTop: 16 }}>
                <Btn variant="ghost" icon={ChevronRight} onClick={() => go("packlists")} fullWidth={isMobile}>
                  {t("dash.viewAllPacklists")}
                </Btn>
              </div>
            </>
          )}

          {/* Library CTA card */}
          <div style={{
            marginTop: isMobile ? 32 : 56,
            padding: isMobile ? 24 : 36,
            background: C.forestDeep,
            color: C.paper,
            border: `1.5px solid ${C.ink}`,
            display: "flex",
            flexDirection: isMobile ? "column" : "row",
            alignItems: isMobile ? "flex-start" : "center",
            justifyContent: "space-between",
            gap: isMobile ? 18 : 24,
            position: "relative",
            overflow: "hidden",
          }}>
            <div style={{ position: "absolute", top: -10, right: -10, opacity: 0.12 }}>
              <Globe size={isMobile ? 120 : 180} strokeWidth={1} />
            </div>
            <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
              <div style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", opacity: 0.7 }}>
                {t("nav.library")} · 06
              </div>
              <div style={{ marginTop: 8, fontFamily: F.display, fontSize: isMobile ? 28 : 40, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05 }}>
                {t("dash.libraryCardTitle")}<span style={{ color: C.rust }}>.</span>
              </div>
              <div style={{ marginTop: 8, fontFamily: F.display, fontStyle: "italic", fontSize: isMobile ? 14 : 16, opacity: 0.85 }}>
                {t("dash.libraryCardTag")}
              </div>
            </div>
            <Btn variant="rust" icon={ChevronRight} onClick={() => go("library")} fullWidth={isMobile}>
              {t("dash.libraryCardCta")}
            </Btn>
          </div>
        </div>
        <Footer />
      </div>
    </div>
  );
}

function AddPanel({ title, children, onSave, onCancel, saveLabel }) {
  const { t } = useI18n();
  const { isMobile } = useViewport();
  return (
    <div style={{ marginBottom: isMobile ? 24 : 32, padding: isMobile ? 16 : 24, background: C.paperDeep, border: `1.5px dashed ${C.ink}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: isMobile ? 18 : 24, gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Coord>{t("form.newEntry")}</Coord>
          <div style={{ marginTop: 4, fontFamily: F.display, fontSize: isMobile ? 22 : 26, fontWeight: 700, letterSpacing: "-0.02em" }}>{title}</div>
        </div>
        <Stamp rotate={4} color={C.forest}>{t("form.draft")}</Stamp>
      </div>
      {children}
      <div style={{ marginTop: isMobile ? 24 : 32, display: "flex", gap: 10, justifyContent: isMobile ? "stretch" : "flex-end", flexDirection: isMobile ? "column-reverse" : "row" }}>
        <Btn variant="ghost" icon={X} onClick={onCancel} fullWidth={isMobile}>{t("common.discard")}</Btn>
        <Btn variant="rust" icon={Check} onClick={onSave} fullWidth={isMobile}>{saveLabel || t("common.save")}</Btn>
      </div>
    </div>
  );
}

function AddItemForm({ categories, onAdd, onCancel, initial, defaultCategory }) {
  const { t, lang, units } = useI18n();
  const editMode = !!initial;
  const [name, setName] = useState(initial?.name || "");
  const [category, setCategory] = useState(initial?.category || defaultCategory || (categories[0] ? categories[0].name : ""));
  const [quantity, setQuantity] = useState(initial?.quantity || 1);
  const [size, setSize] = useState(initial?.size || "");
  // Pre-fill weight in the user's chosen unit so edits feel natural
  const [weight, setWeight] = useState(initial?.weight ? formatWeight(initial.weight, units) : "");
  const [consumable, setConsumable] = useState(initial?.consumable || false);
  // hasExpiry is the toggle. It's derived from whether `initial` had an expiry value.
  const [hasExpiry, setHasExpiry] = useState(!!initial?.expiry);
  const [expiry, setExpiry] = useState(initial?.expiry || "");
  const [remindDays, setRemindDays] = useState(initial?.remindDays != null ? initial.remindDays : 30);

  const save = () => {
    if (!name.trim()) return;
    const qty = parseInt(quantity, 10);
    // Normalize weight: if user typed lb / oz, convert to kg for canonical storage.
    // If they typed plain "1.5" with no unit, treat as kg in metric mode and lb in imperial mode.
    let weightStr = weight.trim();
    if (weightStr) {
      const m = weightStr.match(/(-?\d+(?:[.,]\d+)?)\s*(kg|g|lb|oz)?/i);
      if (m) {
        const v = parseFloat(m[1].replace(",", "."));
        let u = (m[2] || "").toLowerCase();
        if (!u) u = units === "imperial" ? "lb" : "kg";
        let kg;
        if (u === "g") kg = v / 1000;
        else if (u === "lb") kg = v / KG_TO_LB;
        else if (u === "oz") kg = v / KG_TO_LB / 16;
        else kg = v;
        weightStr = `${kg.toFixed(2)} kg`;
      }
    } else {
      weightStr = "0.00 kg";
    }
    onAdd({
      name: name.trim(),
      category,
      quantity: isNaN(qty) || qty < 1 ? 1 : qty,
      size: size.trim(),
      weight: weightStr,
      consumable,
      // Only persist expiry data when the toggle is on
      expiry: hasExpiry ? expiry : "",
      remindDays: hasExpiry && expiry ? remindDays : null,
    });
  };

  return (
    <AddPanel
      title={editMode ? t("form.editItemTitle") : t("form.itemTitle")}
      onSave={save}
      onCancel={onCancel}
      saveLabel={editMode ? t("common.save") : t("form.fileItem")}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 24 }}>
        <Field label={t("form.itemName")} icon={Tag} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("form.itemNamePh")} />
        <Field label={t("form.qty")} type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="1" />
        <Field label={t("form.size")} value={size} onChange={(e) => setSize(e.target.value)} placeholder={t("form.sizePh")} />
        <Field label={t("form.weight")} value={weight} onChange={(e) => setWeight(e.target.value)} placeholder={units === "imperial" ? t("form.weightPhImperial") : t("form.weightPh")} />
      </div>

      <div style={{ marginTop: 24, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 24, alignItems: "end" }}>
        <label style={{ display: "block" }}>
          <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
            <Layers size={11} />{t("form.category")}
          </div>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            style={{
              width: "100%",
              padding: "10px 28px 10px 0",
              background: "transparent",
              border: "none",
              borderBottom: `1.5px solid ${C.ink}`,
              outline: "none",
              fontFamily: F.body,
              fontSize: 16,
              color: C.ink,
              appearance: "none",
              WebkitAppearance: "none",
              MozAppearance: "none",
              backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%231A2421' stroke-width='1.5' fill='none'/></svg>")`,
              backgroundRepeat: "no-repeat",
              backgroundPosition: "right 4px center",
              cursor: "pointer",
            }}
          >
            {categories.map((c) => (
              <option key={c.id} value={c.name}>{tOrLiteral(lang, "cat", c.name)}</option>
            ))}
          </select>
        </label>

        <div>
          <div style={{ marginBottom: 8, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
            {t("form.consumable")}
          </div>
          <div style={{ display: "inline-flex", border: `1.5px solid ${C.ink}` }}>
            {[[t("common.no"), false], [t("common.yes"), true]].map(([label, val]) => {
              const sel = consumable === val;
              return (
                <button
                  key={String(val)}
                  onClick={() => setConsumable(val)}
                  style={{
                    padding: "8px 18px",
                    border: "none",
                    cursor: "pointer",
                    fontFamily: F.mono,
                    fontSize: 11,
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    fontWeight: 700,
                    background: sel ? C.ink : "transparent",
                    color: sel ? C.paper : C.ink,
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div style={{ marginTop: 6, fontFamily: F.body, fontSize: 11, color: C.muted, fontStyle: "italic" }}>
            {t("form.consumableHint")}
          </div>
        </div>

        <div>
          <div style={{ marginBottom: 8, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
            {t("form.hasExpiry")}
          </div>
          <div style={{ display: "inline-flex", border: `1.5px solid ${C.ink}` }}>
            {[[t("common.no"), false], [t("common.yes"), true]].map(([label, val]) => {
              const sel = hasExpiry === val;
              return (
                <button
                  key={String(val)}
                  onClick={() => setHasExpiry(val)}
                  style={{
                    padding: "8px 18px",
                    border: "none",
                    cursor: "pointer",
                    fontFamily: F.mono,
                    fontSize: 11,
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    fontWeight: 700,
                    background: sel ? C.ink : "transparent",
                    color: sel ? C.paper : C.ink,
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div style={{ marginTop: 6, fontFamily: F.body, fontSize: 11, color: C.muted, fontStyle: "italic" }}>
            {t("form.hasExpiryHint")}
          </div>
        </div>
      </div>

      {hasExpiry && (
        <div style={{ marginTop: 24, padding: 16, background: C.paper, border: `1px dashed ${C.line}`, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 24 }}>
          <Field label={t("form.expiryDate")} type="date" icon={Calendar} value={expiry} onChange={(e) => setExpiry(e.target.value)} />
          {expiry && (
            <label style={{ display: "block" }}>
              <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
                <AlertTriangle size={11} />{t("form.remindMe")}
              </div>
              <select
                value={remindDays}
                onChange={(e) => setRemindDays(parseInt(e.target.value, 10))}
                style={{
                  width: "100%",
                  padding: "10px 28px 10px 0",
                  background: "transparent",
                  border: "none",
                  borderBottom: `1.5px solid ${C.ink}`,
                  outline: "none",
                  fontFamily: F.body,
                  fontSize: 16,
                  color: C.ink,
                  appearance: "none",
                  WebkitAppearance: "none",
                  MozAppearance: "none",
                  backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%231A2421' stroke-width='1.5' fill='none'/></svg>")`,
                  backgroundRepeat: "no-repeat",
                  backgroundPosition: "right 4px center",
                  cursor: "pointer",
                }}
              >
                {[0,1,3,7,14,30,60,90,180,365].map((d) => (
                  <option key={d} value={d}>{t(`form.remind.${d}`)}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
    </AddPanel>
  );
}

/* ============================================================
   Modal — lightweight overlay shell. Wraps any form/content,
   dims the background, locks body scroll, ESC closes.
   Used by the edit dialogs for items, kits, and categories.
   ============================================================ */
function Modal({ title, onClose, children }) {
  const { isMobile } = useViewport();

  // Lock body scroll while open + ESC to close
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title || "Dialog"}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 1100,
        background: "rgba(26, 36, 33, 0.55)",
        display: "flex", alignItems: isMobile ? "stretch" : "flex-start", justifyContent: "center",
        padding: isMobile ? 0 : "32px 24px",
        overflowY: "auto",
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 720,
          background: C.paper,
          border: `1.5px solid ${C.ink}`,
          boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
          display: "flex", flexDirection: "column",
          maxHeight: isMobile ? "100%" : "calc(100vh - 64px)",
        }}
      >
        {/* Header */}
        {title && (
          <div style={{
            padding: isMobile ? "14px 18px" : "16px 24px",
            background: C.ink, color: C.paper,
            display: "flex", alignItems: "center", gap: 12,
            borderBottom: `2px solid ${C.rust}`,
          }}>
            <Pencil size={16} strokeWidth={1.6} />
            <div style={{ flex: 1, minWidth: 0, fontFamily: F.display, fontSize: isMobile ? 16 : 18, fontWeight: 700, letterSpacing: "-0.01em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {title}
            </div>
            <button onClick={onClose}
              style={{ width: 32, height: 32, background: "transparent", border: `1px solid ${C.paper}`, color: C.paper, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
              aria-label="Close">
              <X size={14} />
            </button>
          </div>
        )}

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? "16px 14px" : "20px 24px" }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function AddCategoryForm({ onAdd, onCancel, initial }) {
  const { t } = useI18n();
  const editMode = !!initial;
  const [name, setName] = useState(initial?.name || "");
  const save = () => { if (!name.trim()) return; onAdd({ name: name.trim() }); };
  return (
    <AddPanel title={editMode ? t("form.editCatTitle") : t("form.catTitle")} onSave={save} onCancel={onCancel} saveLabel={editMode ? t("common.save") : t("form.fileCategory")}>
      <Field label={t("form.catName")} icon={Layers} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("form.catNamePh")} />
    </AddPanel>
  );
}

function AddTravelTypeForm({ onAdd, onCancel }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [climate, setClimate] = useState("");
  const [days, setDays] = useState("");
  const save = () => { if (!name.trim()) return; onAdd({ name: name.trim(), climate: climate.trim() || "Variable", days: days.trim() || "1-7" }); };
  return (
    <AddPanel title={t("form.typeTitle")} onSave={save} onCancel={onCancel} saveLabel={t("form.fileType")}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 24 }}>
        <Field label={t("form.typeName")} icon={Globe} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("form.typeNamePh")} />
        <Field label={t("form.climate")} value={climate} onChange={(e) => setClimate(e.target.value)} placeholder={t("form.climatePh")} />
        <Field label={t("form.duration")} value={days} onChange={(e) => setDays(e.target.value)} placeholder={t("form.durationPh")} />
      </div>
    </AddPanel>
  );
}

function ItemsView({ items, onToggle, onDelete, onEdit, emptyLabel, emptyHint, packlists, setPacklists, categories, kits }) {
  const { t, locale, lang, units } = useI18n();
  const { isMobile } = useViewport();
  if (items.length === 0) return <EmptyState label={emptyLabel || t("inv.emptyItems")} hint={emptyHint || t("inv.emptyItemsHint")} />;

  const fmtExpiry = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(locale, { month: "short", year: "numeric" }).toUpperCase();
  };
  const isExpired = (iso) => {
    if (!iso) return false;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return false;
    return d.getTime() < Date.now();
  };
  // True when expiry is within `days` days of now (default 30) but not yet expired.
  // Items with their own remindDays setting use that; otherwise fall back to 30.
  const isExpiringSoon = (item) => {
    if (!item.expiry) return false;
    const d = new Date(item.expiry);
    if (isNaN(d.getTime())) return false;
    const now = Date.now();
    if (d.getTime() < now) return false; // already expired
    const days = (item.remindDays != null && item.remindDays > 0) ? item.remindDays : 30;
    const cutoff = now + days * 24 * 60 * 60 * 1000;
    return d.getTime() <= cutoff;
  };
  // Find which kits an item belongs to. Returns array of kit objects.
  const kitsForItem = (itemId) => {
    if (!kits) return [];
    return kits.filter((k) => (k.itemIds || []).includes(itemId));
  };
  // Pretty-print the Kit column. If 1 kit → kit name. If 2+ → "N kits".
  // If 0 → em dash.
  const kitColumnLabel = (itemId) => {
    const list = kitsForItem(itemId);
    if (list.length === 0) return "—";
    if (list.length === 1) return list[0].name;
    return `${list.length} ${t("inv.kitsLabel")}`;
  };

  // ---------- MOBILE: stacked card layout ----------
  if (isMobile) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map((it, idx) => {
          const expired = it.expiry && isExpired(it.expiry);
          const expSoon = it.expiry && !expired && isExpiringSoon(it);
          const expiryColor = expired ? C.rust : (expSoon ? C.rust : C.inkSoft);
          const meta = [];
          if (it.quantity && it.quantity > 1) meta.push(`${t("inv.metaQty")} ${it.quantity}`);
          if (it.size) meta.push(`${t("inv.metaSize")} ${it.size}`);
          const kitLabel = kitColumnLabel(it.id);
          return (
            <div key={it.id} style={{ background: C.paper, border: `1.5px solid ${C.ink}`, padding: 14, display: "flex", gap: 12, alignItems: "stretch" }}>
              {/* Center: name + meta + chips */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.15em" }}>
                  {String(idx + 1).padStart(3, "0")}
                </div>
                <div style={{ marginTop: 2, fontFamily: F.display, fontSize: 17, fontWeight: 600, lineHeight: 1.2, wordBreak: "break-word" }}>
                  {onEdit ? (
                    <button onClick={() => onEdit(it.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", fontWeight: "inherit", color: C.ink, textAlign: "left", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 4, textDecorationColor: C.muted }}>
                      {it.name}
                    </button>
                  ) : it.name}
                </div>
                <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  {it.category && (
                    <span style={{ padding: "2px 6px", fontFamily: F.mono, fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", border: `1px solid ${C.ink}`, fontWeight: 700 }}>
                      {tOrLiteral(lang, "cat", it.category)}
                    </span>
                  )}
                  {kitLabel !== "—" && (
                    <span style={{ padding: "2px 6px", fontFamily: F.mono, fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", border: `1px solid ${C.forest}`, color: C.forest, fontWeight: 700 }}>
                      {kitLabel}
                    </span>
                  )}
                  {it.consumable && (
                    <span style={{ padding: "2px 6px", fontFamily: F.mono, fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", border: `1px solid ${C.ochre}`, color: C.ochre, fontWeight: 700 }}>
                      {t("inv.badgeConsumable")}
                    </span>
                  )}
                  {expired && (
                    <span style={{ padding: "2px 6px", fontFamily: F.mono, fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", border: `1px solid ${C.rust}`, color: C.rust, fontWeight: 700 }}>
                      {t("inv.badgeExpired")}
                    </span>
                  )}
                </div>
                {it.expiry && (
                  <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 11, letterSpacing: "0.1em", color: expiryColor, fontWeight: (expired || expSoon) ? 700 : 500, textTransform: "uppercase" }}>
                    {t("inv.metaExp")} {fmtExpiry(it.expiry)}
                  </div>
                )}
                {meta.length > 0 && (
                  <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.05em" }}>
                    {meta.join("  /  ")}
                  </div>
                )}
                {packlists && setPacklists && (
                  <div style={{ marginTop: 8 }}>
                    <AddToPacklistMenu
                      kind="item" entityId={it.id} entityName={it.name}
                      packlists={packlists} setPacklists={setPacklists}
                    />
                  </div>
                )}
              </div>

              {/* Delete on the right */}
              <button
                onClick={() => onDelete(it.id)}
                style={{
                  width: 40, minWidth: 40,
                  cursor: "pointer",
                  background: "transparent",
                  border: `1px solid ${C.rust}`,
                  color: C.rust,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  alignSelf: "flex-start",
                  marginTop: 2,
                }}
                aria-label="Delete"
              >
                <Trash2 size={16} />
              </button>
            </div>
          );
        })}
      </div>
    );
  }

  // ---------- DESKTOP: original tabular layout ----------
  return (
    <div style={{ border: `1.5px solid ${C.ink}` }}>
      <div style={{ display: "grid", gridTemplateColumns: "60px 2fr 1.4fr 1fr 1fr 60px", padding: "12px 24px", background: C.ink, color: C.paper, fontFamily: F.mono, fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase" }}>
        <div>{t("inv.colNum")}</div><div>{t("inv.colItem")}</div><div>{t("inv.colKit")}</div><div>{t("inv.colCategory")}</div><div>{t("inv.colExpiry")}</div><div></div>
      </div>
      {items.map((it, idx) => {
        const expired = it.expiry && isExpired(it.expiry);
        const expSoon = it.expiry && !expired && isExpiringSoon(it);
        const expiryColor = expired ? C.rust : (expSoon ? C.rust : C.ink);
        const expiryWeight = (expired || expSoon) ? 700 : 400;
        const meta = [];
        if (it.quantity && it.quantity > 1) meta.push(`${t("inv.metaQty")} ${it.quantity}`);
        if (it.size) meta.push(`${t("inv.metaSize")} ${it.size}`);
        return (
          <div key={it.id} style={{ display: "grid", gridTemplateColumns: "60px 2fr 1.4fr 1fr 1fr 60px", padding: "16px 24px", alignItems: "center", borderTop: idx === 0 ? "none" : `1px dashed ${C.line}` }}>
            <div style={{ fontFamily: F.mono, fontSize: 12, color: C.muted }}>{String(idx + 1).padStart(3, "0")}</div>
            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                {onEdit ? (
                  <button onClick={() => onEdit(it.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: F.display, fontSize: 18, fontWeight: 500, color: C.ink, textAlign: "left", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 4, textDecorationColor: C.muted }}>
                    {it.name}
                  </button>
                ) : (
                  <span style={{ fontFamily: F.display, fontSize: 18, fontWeight: 500 }}>{it.name}</span>
                )}
                {it.consumable && (
                  <span style={{ padding: "2px 6px", fontFamily: F.mono, fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", border: `1px solid ${C.ochre}`, color: C.ochre, fontWeight: 700 }}>
                    {t("inv.badgeConsumable")}
                  </span>
                )}
                {expired && (
                  <span style={{ padding: "2px 6px", fontFamily: F.mono, fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", border: `1px solid ${C.rust}`, color: C.rust, fontWeight: 700 }}>
                    {t("inv.badgeExpired")}
                  </span>
                )}
              </div>
              {meta.length > 0 && (
                <div style={{ marginTop: 2, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.05em" }}>
                  {meta.join("  /  ")}
                </div>
              )}
              {packlists && setPacklists && (
                <div style={{ marginTop: 6 }}>
                  <AddToPacklistMenu
                    kind="item" entityId={it.id} entityName={it.name}
                    packlists={packlists} setPacklists={setPacklists}
                  />
                </div>
              )}
            </div>
            {/* Kit column — single name, count, or em dash */}
            <div style={{ fontFamily: F.body, fontSize: 14, color: kitsForItem(it.id).length === 0 ? C.muted : C.ink }}>
              {kitColumnLabel(it.id)}
            </div>
            {/* Category */}
            <div>
              {it.category ? (
                <span style={{ padding: "4px 8px", fontFamily: F.mono, fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", border: `1px solid ${C.ink}` }}>{tOrLiteral(lang, "cat", it.category)}</span>
              ) : (
                <span style={{ fontFamily: F.body, fontSize: 14, color: C.muted }}>—</span>
              )}
            </div>
            {/* Expiry — red when within reminder window or already past */}
            <div style={{ fontFamily: F.mono, fontSize: 12, color: expiryColor, fontWeight: expiryWeight, letterSpacing: "0.05em" }}>
              {it.expiry ? fmtExpiry(it.expiry) : <span style={{ color: C.muted }}>—</span>}
            </div>
            <div style={{ textAlign: "right" }}>
              <button onClick={() => onDelete(it.id)} style={{ width: 28, height: 28, cursor: "pointer", background: "transparent", border: "none", color: C.rust, display: "inline-flex", alignItems: "center", justifyContent: "center" }} aria-label="Delete">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================
   AddToPacklistMenu — small dropdown attached to any item, kit,
   or category row in Inventory. Lets the user pick which saved
   Trip/Packlist to add this thing to, or create a new one inline.
   Shows a brief inline confirmation after a successful add.

   Props:
     kind            "item" | "kit" | "category"
     entityId        the id to add (item id, kit id, or category id)
     entityName      display label used in the confirmation toast
     packlists       array of saved packlists
     setPacklists    setter to commit changes
     placement       "left" | "right" — which side the dropdown opens from
   ============================================================ */
function AddToPacklistMenu({ kind, entityId, entityName, packlists, setPacklists, placement = "right" }) {
  const { t } = useI18n();
  const { isMobile } = useViewport();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [confirmed, setConfirmed] = useState("");

  // Close the dropdown if the user taps anywhere outside it.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (!e.target.closest?.("[data-addto-root]")) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Auto-clear confirmation after a couple seconds
  useEffect(() => {
    if (!confirmed) return;
    const tm = setTimeout(() => setConfirmed(""), 2400);
    return () => clearTimeout(tm);
  }, [confirmed]);

  // Field key on a packlist that holds this entity kind
  const fieldFor = (k) =>
    k === "item" ? "itemIds" : k === "kit" ? "kitIds" : "categoryIds";

  const addToPacklist = (plId) => {
    const field = fieldFor(kind);
    let alreadyHad = false;
    let plName = "";
    setPacklists(packlists.map((p) => {
      if (p.id !== plId) return p;
      plName = p.name;
      const existing = p[field] || [];
      if (existing.includes(entityId)) { alreadyHad = true; return p; }
      return { ...p, [field]: [...existing, entityId] };
    }));
    setOpen(false);
    setConfirmed(alreadyHad ? t("addTo.alreadyIn") : t("addTo.confirmedFmt", { name: plName }));
  };

  const createAndAdd = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const newId = uid("pl");
    const field = fieldFor(kind);
    const newPl = {
      id: newId,
      name: trimmed,
      notes: "",
      dest: "",
      date: "",
      type: "",
      kitIds: kind === "kit" ? [entityId] : [],
      itemIds: kind === "item" ? [entityId] : [],
      categoryIds: kind === "category" ? [entityId] : [],
    };
    setPacklists([newPl, ...packlists]);
    setNewName("");
    setCreating(false);
    setOpen(false);
    setConfirmed(t("addTo.confirmedFmt", { name: trimmed }));
  };

  return (
    <div data-addto-root style={{ position: "relative", display: "inline-block" }}>
      {/* Trigger */}
      <button
        onClick={() => { setOpen(!open); setCreating(false); }}
        title={t("addTo.button")}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          padding: "6px 10px",
          background: open ? C.rust : "transparent",
          color: open ? C.paper : C.rust,
          border: `1.5px solid ${C.rust}`,
          cursor: "pointer",
          fontFamily: F.mono, fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700,
          display: "inline-flex", alignItems: "center", gap: 4,
          minHeight: 32,
        }}
      >
        <Plus size={12} strokeWidth={2.5} /> {t("addTo.button")}
      </button>

      {/* Inline confirmation pill */}
      {confirmed && (
        <span style={{
          position: "absolute",
          top: "100%", marginTop: 6,
          [placement === "left" ? "right" : "left"]: 0,
          padding: "4px 10px",
          background: C.forest, color: C.paper,
          fontFamily: F.mono, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700,
          whiteSpace: "nowrap",
          zIndex: 5,
        }}>
          ✓ {confirmed}
        </span>
      )}

      {/* Dropdown */}
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "100%", marginTop: 4,
            [placement === "left" ? "right" : "left"]: 0,
            minWidth: isMobile ? 220 : 260,
            maxWidth: 320,
            background: C.paper,
            border: `2px solid ${C.rust}`,
            boxShadow: "0 8px 22px rgba(0,0,0,0.18)",
            zIndex: 10,
          }}
        >
          {/* Header */}
          <div style={{ padding: "10px 12px", background: C.rust, color: C.paper, fontFamily: F.mono, fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
            {t("addTo.heading")}
          </div>

          {/* Existing packlists */}
          <div style={{ maxHeight: 280, overflowY: "auto" }}>
            {packlists.length === 0 ? (
              <div style={{ padding: 12, fontFamily: F.body, fontSize: 12, color: C.muted, fontStyle: "italic", textAlign: "center" }}>
                {t("addTo.empty")}
              </div>
            ) : (
              packlists.map((p) => {
                const field = fieldFor(kind);
                const has = (p[field] || []).includes(entityId);
                return (
                  <button
                    key={p.id}
                    onClick={() => addToPacklist(p.id)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      width: "100%", padding: "10px 12px",
                      background: "transparent", border: "none", borderBottom: `1px dashed ${C.line}`,
                      cursor: "pointer", textAlign: "left",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: F.body, fontSize: 13, fontWeight: 600, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {p.name}
                      </div>
                      {(p.dest || p.date) && (
                        <div style={{ fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginTop: 2 }}>
                          {[p.dest, p.date].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                    {has ? (
                      <span style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: "0.12em", color: C.forest, fontWeight: 700, flexShrink: 0 }}>
                        ✓ ON
                      </span>
                    ) : (
                      <Plus size={13} strokeWidth={2} color={C.muted} style={{ flexShrink: 0 }} />
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* Inline create-new */}
          {!creating ? (
            <button
              onClick={() => setCreating(true)}
              style={{
                display: "block", width: "100%", padding: "10px 12px",
                background: C.paperDeep, border: "none", borderTop: `1.5px solid ${C.rust}`,
                cursor: "pointer", textAlign: "left",
                fontFamily: F.mono, fontSize: 11, color: C.rust, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700,
              }}
            >
              {t("addTo.newOne")}
            </button>
          ) : (
            <div style={{ padding: 12, background: C.paperDeep, borderTop: `1.5px solid ${C.rust}` }}>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") createAndAdd(); }}
                placeholder={t("addTo.newName")}
                autoFocus
                style={{
                  width: "100%", padding: "8px 0", marginBottom: 10,
                  background: "transparent", border: "none", borderBottom: `1.5px solid ${C.ink}`,
                  outline: "none", fontFamily: F.body, fontSize: 14, color: C.ink,
                }}
              />
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <Btn variant="ghost" icon={X} onClick={() => { setCreating(false); setNewName(""); }}>
                  {t("addTo.newCancel")}
                </Btn>
                <Btn variant="rust" icon={Check} onClick={createAndAdd} disabled={!newName.trim()}>
                  {t("addTo.newCreate")}
                </Btn>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CategoriesView({ categories, items, kits, onDelete, onOpen, onShare, onPublish, onEdit, packlists, setPacklists }) {
  const { t, lang, units } = useI18n();
  const { isMobile } = useViewport();
  // Collapse-by-default state. expanded[id] = true means show items beneath.
  const [expanded, setExpanded] = useState({});
  const toggleExpanded = (id) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  if (categories.length === 0) return <EmptyState label={t("inv.emptyCats")} hint={t("inv.emptyCatsHint")} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      {categories.map((c) => {
        const Icon = iconFor(c.icon);
        const catItems = items.filter((it) => it.category === c.name);
        const kitCount = kits.filter((k) => k.category === c.name).length;
        const isOpen = !!expanded[c.id];
        return (
          <div key={c.id}>
            {/* Header row — name + counts on the left, actions on the right */}
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              marginBottom: 8, paddingBottom: 8,
              borderBottom: `1.5px solid ${C.ink}`,
            }}>
              <Icon size={20} strokeWidth={1.4} color={C.forest} />
              <button
                onClick={() => toggleExpanded(c.id)}
                style={{
                  flex: 1, minWidth: 0, textAlign: "left",
                  background: "none", border: "none", padding: 0, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 8,
                }}>
                {/* Chevron rotates to indicate collapse state */}
                <ChevronRight
                  size={16}
                  strokeWidth={2}
                  color={C.muted}
                  style={{ flexShrink: 0, transform: isOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: F.display, fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", color: C.ink }}>
                    {tOrLiteral(lang, "cat", c.name)}
                  </div>
                  <div style={{ marginTop: 2, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                    {t("pl.catLabel")} · {catItems.length} {catItems.length === 1 ? "item" : "items"}{kitCount > 0 ? ` · ${kitCount} ${kitCount === 1 ? "kit" : "kits"}` : ""}
                  </div>
                </div>
              </button>
              {/* Action icons — share, publish, edit, delete */}
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                {onShare && (
                  <button onClick={() => onShare(c)}
                    style={{ width: 30, height: 30, background: C.paperDeep, border: `1px solid ${C.ink}`, color: C.ink, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                    title={t("share.btn")} aria-label={t("share.btn")}>
                    <ChevronRight size={13} style={{ transform: "rotate(-45deg)" }} />
                  </button>
                )}
                {onPublish && (
                  <button onClick={() => onPublish(c)}
                    style={{ width: 30, height: 30, background: C.paperDeep, border: `1px solid ${C.forest}`, color: C.forest, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                    title={t("lib.publishBtn")} aria-label={t("lib.publishBtn")}>
                    <Globe size={13} />
                  </button>
                )}
                {onEdit && (
                  <button onClick={() => onEdit(c.id)}
                    style={{ width: 30, height: 30, background: C.paperDeep, border: `1px solid ${C.ink}`, color: C.ink, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                    title={t("pl.editBtn")} aria-label={t("pl.editBtn")}>
                    <Pencil size={13} />
                  </button>
                )}
                <button onClick={() => onDelete(c.id)}
                  style={{ width: 30, height: 30, background: C.paperDeep, border: `1px solid ${C.rust}`, color: C.rust, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                  title={t("pl.deleteBtn")} aria-label={t("pl.deleteBtn")}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {/* Add-to-Packlist + items list — both hidden when collapsed */}
            {isOpen && (
              <>
                {packlists && setPacklists && (
                  <div style={{ marginBottom: 8 }}>
                    <AddToPacklistMenu
                      kind="category" entityId={c.id} entityName={c.name}
                      packlists={packlists} setPacklists={setPacklists}
                    />
                  </div>
                )}

                {catItems.length === 0 ? (
                  <div style={{ paddingLeft: 28, fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.inkSoft }}>
                    {t("kitDetail.empty")}
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {catItems.map((it) => (
                      <div key={it.id}
                        style={{
                          display: "flex", alignItems: "center", gap: 10,
                          padding: "8px 12px 8px 28px",
                          borderBottom: `1px solid ${C.line}`,
                        }}>
                        <span style={{ flex: 1, minWidth: 0, fontFamily: F.body, fontSize: 14, color: C.ink }}>
                          {it.name}
                        </span>
                        {it.weight && (
                          <span style={{ fontFamily: F.mono, fontSize: 11, color: C.muted, fontWeight: 600 }}>
                            {formatWeight(it.weight, units)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TravelTypesView({ types, onDelete }) {
  const { t, lang } = useI18n();
  if (types.length === 0) return <EmptyState label={t("inv.emptyTypes")} hint={t("inv.emptyTypesHint")} />;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
      {types.map((tt, idx) => {
        const Icon = iconFor(tt.icon);
        const dark = idx % 5 === 1 || idx % 5 === 4;
        return (
          <div key={tt.id} style={{ padding: 24, position: "relative", overflow: "hidden", background: dark ? C.forestDeep : C.paper, color: dark ? C.paper : C.ink, border: `1.5px solid ${dark ? C.forestDeep : C.ink}`, minHeight: 200 }}>
            <button onClick={() => onDelete(tt.id)} style={{ position: "absolute", top: 12, right: 12, width: 30, height: 30, cursor: "pointer", background: dark ? "rgba(0,0,0,0.3)" : C.paperDeep, border: `1px solid ${dark ? C.ochre : C.rust}`, color: dark ? C.ochre : C.rust, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2 }} aria-label="Delete">
              <Trash2 size={14} />
            </button>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <Icon size={28} strokeWidth={1.3} />
              <span style={{ fontFamily: F.mono, fontSize: 11, color: dark ? C.paper : C.muted, opacity: 0.8 }}>{tt.days} {t("inv.daysLabel")}</span>
            </div>
            <div style={{ marginTop: 32, fontFamily: F.display, fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1 }}>{tOrLiteral(lang, "tt", tt.name)}</div>
            <div style={{ marginTop: 6, fontFamily: F.display, fontStyle: "italic", fontSize: 15, opacity: 0.85 }}>{tOrLiteral(lang, "climate", tt.climate)}</div>
          </div>
        );
      })}
    </div>
  );
}

function AddKitForm({ categories, items, onAdd, onCancel, defaultCategory, initial, onAddItem }) {
  const { t, lang, units } = useI18n();
  const { isMobile } = useViewport();
  const editMode = !!initial;
  const [name, setName] = useState(initial?.name || "");
  const [category, setCategory] = useState(initial?.category || defaultCategory || "");
  // Items currently in this kit. In create mode start empty; in edit mode
  // start with whatever the kit already has. Toggling a row adds/removes
  // the item id from this set.
  const [itemIds, setItemIds] = useState(initial?.itemIds || []);
  const [showAddItems, setShowAddItems] = useState(false);
  // Toggle for the full "Create new item" modal (uses AddItemForm — same as Items page)
  const [showCreateItem, setShowCreateItem] = useState(false);

  const inKit       = (items || []).filter((it) => itemIds.includes(it.id));
  const notInKit    = (items || []).filter((it) => !itemIds.includes(it.id));
  const removeItem  = (id) => setItemIds(itemIds.filter((x) => x !== id));
  const addItem     = (id) => setItemIds([...itemIds, id]);

  const save = () => {
    if (!name.trim()) return;
    onAdd({ name: name.trim(), category: category || null, itemIds });
  };

  return (
    <AddPanel title={editMode ? t("kit.editFormTitle") : t("kit.formTitle")} onSave={save} onCancel={onCancel} saveLabel={editMode ? t("common.save") : t("kit.fileKit")}>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(220px, 1fr))", gap: 22 }}>
        <Field label={t("kit.kitName")} icon={Backpack} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("kit.kitNamePh")} />
        <label style={{ display: "block" }}>
          <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
            <Layers size={11} />{t("kit.category")}
          </div>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            style={{
              width: "100%",
              padding: "10px 28px 10px 0",
              background: "transparent",
              border: "none",
              borderBottom: `1.5px solid ${C.ink}`,
              outline: "none",
              fontFamily: F.body,
              fontSize: 16,
              color: C.ink,
              appearance: "none",
              WebkitAppearance: "none",
              MozAppearance: "none",
              backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%231A2421' stroke-width='1.5' fill='none'/></svg>")`,
              backgroundRepeat: "no-repeat",
              backgroundPosition: "right 4px center",
              cursor: "pointer",
            }}
          >
            <option value="">{t("kit.uncategorized")}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.name}>{tOrLiteral(lang, "cat", c.name)}</option>
            ))}
          </select>
        </label>
      </div>

      {/* === ITEMS IN THIS KIT === only available when items prop is provided */}
      {items && (
        <div style={{ marginTop: 24 }}>
          <div style={{ marginBottom: 10, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
            {t("kitDetail.itemsInKit")} ({inKit.length})
          </div>
          {inKit.length === 0 ? (
            <div style={{ padding: "10px 0", marginBottom: 10, fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.inkSoft }}>
              {t("kitDetail.empty")}
            </div>
          ) : (
            <div style={{ marginBottom: 10, display: "flex", flexDirection: "column", gap: 4 }}>
              {inKit.map((it) => (
                <div key={it.id}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                    background: C.paper, border: `1px solid ${C.line}`,
                  }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: F.body, fontSize: 14, fontWeight: 500, color: C.ink }}>{it.name}</div>
                    <div style={{ marginTop: 2, fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                      {it.category || t("trips.unifiedNoCategory")}{it.weight ? ` · ${formatWeight(it.weight, units)}` : ""}
                    </div>
                  </div>
                  <button type="button" onClick={() => removeItem(it.id)}
                    style={{ width: 28, height: 28, padding: 0, background: "transparent", border: `1px solid ${C.muted}`, color: C.muted, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                    title={t("kitDetail.unlinkItem")}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.rust; e.currentTarget.style.color = C.rust; }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.muted; e.currentTarget.style.color = C.muted; }}>
                    <X size={13} strokeWidth={2.5} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Toggle to reveal the "add existing items" picker */}
          {!showAddItems ? (
            <button type="button" onClick={() => setShowAddItems(true)}
              style={{
                width: "100%", padding: "10px 14px",
                background: "transparent", border: `1.5px solid ${C.ink}`, color: C.ink,
                cursor: "pointer", fontFamily: F.mono, fontSize: 11,
                letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700,
                display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
              }}>
              <Plus size={14} strokeWidth={2.5} /> {t("kitDetail.addExisting")} ({notInKit.length})
            </button>
          ) : (
            <div style={{ padding: 12, background: C.paperDeep, border: `1.5px solid ${C.ink}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
                  {t("kitDetail.tickToAdd")}
                </span>
                <button type="button" onClick={() => setShowAddItems(false)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", padding: 4 }} aria-label="Close">
                  <X size={14} />
                </button>
              </div>
              {notInKit.length === 0 ? (
                <div style={{ padding: "10px 0", fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.inkSoft }}>
                  {t("kitDetail.noOthersToAdd")}
                </div>
              ) : (
                <div style={{ maxHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                  {notInKit.map((it) => (
                    <button key={it.id} type="button"
                      onClick={() => addItem(it.id)}
                      style={{
                        display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                        background: "transparent", border: `1px solid ${C.line}`,
                        cursor: "pointer", textAlign: "left",
                      }}>
                      <span style={{ width: 18, height: 18, flexShrink: 0, border: `1.5px solid ${C.muted}`, background: "transparent" }}></span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: F.body, fontSize: 14, fontWeight: 500, color: C.ink }}>{it.name}</div>
                        <div style={{ marginTop: 1, fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                          {it.category || t("trips.unifiedNoCategory")}{it.weight ? ` · ${formatWeight(it.weight, units)}` : ""}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Create-new-item button (only when caller wired onAddItem) */}
          {onAddItem && (
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={() => setShowCreateItem(true)}
                style={{
                  width: "100%", padding: "10px 14px",
                  background: "transparent", border: `1.5px dashed ${C.rust}`, color: C.rust,
                  cursor: "pointer", fontFamily: F.mono, fontSize: 11,
                  letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700,
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                }}>
                <Plus size={14} strokeWidth={2.5} /> {t("kitDetail.createNew")}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Full create-new-item modal — opens on top of this form. Uses the
          same AddItemForm as the Items page so all fields are available
          (name, weight, category, quantity, size, consumable, expiry, notes). */}
      {onAddItem && showCreateItem && (
        <Modal title={t("form.addItemTitle")} onClose={() => setShowCreateItem(false)}>
          <AddItemForm
            categories={categories}
            defaultCategory={category || ""}
            onAdd={(data) => {
              const created = { id: uid("it"), packed: false, ...data };
              onAddItem(created);
              setItemIds([...itemIds, created.id]);
              setShowCreateItem(false);
            }}
            onCancel={() => setShowCreateItem(false)}
          />
        </Modal>
      )}
    </AddPanel>
  );
}

function KitCard({ kit, items, categories, onUpdate, onDelete, onShare, onPublish, packlists, setPacklists, onEdit }) {
  const { t, lang, units } = useI18n();
  const { isMobile } = useViewport();
  const [editing, setEditing] = useState(false);
  const [pickingCategory, setPickingCategory] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // If this kit was received as a live link, recipient can't edit it
  const isLinked = !!kit.linkedFrom;

  // Filter to items that still exist (in case some were deleted from inventory)
  const kitItems = kit.itemIds.map((id) => items.find((i) => i.id === id)).filter(Boolean);
  const totalKg = kitItems.reduce((s, i) => s + parseKg(i.weight || ""), 0);
  const weightStr = formatWeightFromKg(totalKg, units);

  const isInKit = (id) => kit.itemIds.includes(id);
  const toggleItem = (id) => {
    const next = isInKit(id) ? kit.itemIds.filter((x) => x !== id) : [...kit.itemIds, id];
    onUpdate({ ...kit, itemIds: next });
  };

  const setCategory = (catName) => {
    onUpdate({ ...kit, category: catName || null });
    setPickingCategory(false);
  };

  const countLabel = kitItems.length === 1 ? t("kit.itemsInKit_one") : t("kit.itemsInKit_many", { n: kitItems.length });
  const hasCategory = !!kit.category;
  const categoryLabel = hasCategory ? tOrLiteral(lang, "cat", kit.category) : t("kit.uncategorized");

  return (
    <div style={{ background: C.paper, border: `1.5px solid ${C.ink}`, padding: isMobile ? 16 : 24, position: "relative" }}>
      {/* Header row: name + delete */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Coord>KIT</Coord>
          <div style={{ marginTop: 4, fontFamily: F.display, fontSize: isMobile ? 22 : 26, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05 }}>
            {onEdit && !isLinked ? (
              <button onClick={onEdit} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", fontWeight: "inherit", letterSpacing: "inherit", lineHeight: "inherit", color: C.ink, textAlign: "left", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 5, textDecorationColor: C.muted }}>
                {kit.name}
              </button>
            ) : kit.name}
          </div>
          <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
            {countLabel}  /  {t("kit.totalWeight", { weight: weightStr })}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {onShare && !isLinked && (
            <button
              onClick={onShare}
              style={{ width: 38, height: 38, cursor: "pointer", background: "transparent", border: `1.5px solid ${C.ink}`, color: C.ink, display: "flex", alignItems: "center", justifyContent: "center" }}
              aria-label={t("share.btn")}
              title={t("share.btn")}>
              <ChevronRight size={14} style={{ transform: "rotate(-45deg)" }} />
            </button>
          )}
          {onPublish && !isLinked && (
            <button
              onClick={onPublish}
              style={{ width: 38, height: 38, cursor: "pointer", background: "transparent", border: `1.5px solid ${C.forest}`, color: C.forest, display: "flex", alignItems: "center", justifyContent: "center" }}
              aria-label={t("lib.publishBtn")}
              title={t("lib.publishBtn")}>
              <Globe size={14} />
            </button>
          )}
          {!isLinked && (
            <button
              onClick={() => setConfirming(true)}
              style={{ width: 38, height: 38, cursor: "pointer", background: "transparent", border: `1.5px solid ${C.rust}`, color: C.rust, display: "flex", alignItems: "center", justifyContent: "center" }}
              aria-label={t("kit.deleteKit")}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Live link badge if this kit was received as a live share */}
      {isLinked && (
        <div style={{ marginTop: 8, padding: "6px 10px", background: C.paperDeep, border: `1px dashed ${C.rust}`, fontFamily: F.mono, fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", color: C.rust, fontWeight: 700 }}>
          <span style={{ marginRight: 8 }}>{t("inbox.liveBadge")}</span>
          <span style={{ color: C.muted, fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>
            {t("inbox.linkedFrom", { who: `@${kit.linkedFrom.username}` })}
          </span>
        </div>
      )}

      {/* Add-to-Packlist control */}
      {packlists && setPacklists && (
        <div style={{ marginTop: 10 }}>
          <AddToPacklistMenu
            kind="kit" entityId={kit.id} entityName={kit.name}
            packlists={packlists} setPacklists={setPacklists}
          />
        </div>
      )}

      {/* Category badge — shows current state */}
      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{
          padding: "5px 12px",
          fontFamily: F.mono,
          fontSize: 11,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          border: `1.5px solid ${hasCategory ? C.forest : C.muted}`,
          color: hasCategory ? C.forest : C.muted,
          background: hasCategory ? "transparent" : C.paperDeep,
          fontWeight: 700,
          fontStyle: hasCategory ? "normal" : "italic",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}>
          <Layers size={11} />
          {categoryLabel}
        </span>
      </div>

      {/* Dedicated CATEGORY ASSIGNMENT button — impossible to miss */}
      <div style={{ marginTop: 14 }}>
        <Btn
          variant={pickingCategory ? "primary" : "rust"}
          icon={pickingCategory ? X : Layers}
          onClick={() => setPickingCategory(!pickingCategory)}
          fullWidth={true}
        >
          {pickingCategory ? t("common.cancel") : (hasCategory ? t("kit.changeCategory") : t("kit.assignCategory"))}
        </Btn>
      </div>

      {/* Inline category picker */}
      {pickingCategory && (
        <div style={{ marginTop: 12, padding: 12, background: C.paperDeep, border: `1px dashed ${C.ink}` }}>
          {categories.length === 0 ? (
            <div style={{ padding: 8, fontFamily: F.body, fontSize: 13, color: C.muted, fontStyle: "italic" }}>
              {t("kit.noCategoriesYet")}
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {/* Uncategorized option */}
              <button
                onClick={() => setCategory(null)}
                style={{
                  padding: "6px 12px",
                  cursor: "pointer",
                  background: !hasCategory ? C.ink : "transparent",
                  color: !hasCategory ? C.paper : C.ink,
                  border: `1.5px solid ${C.ink}`,
                  fontFamily: F.mono,
                  fontSize: 11,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  fontWeight: 700,
                  fontStyle: "italic",
                }}
              >
                {t("kit.uncategorized")}
              </button>
              {categories.map((c) => {
                const sel = kit.category === c.name;
                return (
                  <button
                    key={c.id}
                    onClick={() => setCategory(c.name)}
                    style={{
                      padding: "6px 12px",
                      cursor: "pointer",
                      background: sel ? C.forest : "transparent",
                      color: sel ? C.paper : C.ink,
                      border: `1.5px solid ${sel ? C.forest : C.ink}`,
                      fontFamily: F.mono,
                      fontSize: 11,
                      letterSpacing: "0.15em",
                      textTransform: "uppercase",
                      fontWeight: 700,
                    }}
                  >
                    {tOrLiteral(lang, "cat", c.name)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Item summary chips when not editing */}
      {!editing && (
        <div style={{ marginTop: 16 }}>
          {kitItems.length === 0 ? (
            <div style={{ padding: 16, background: C.paperDeep, border: `1px dashed ${C.line}`, textAlign: "center" }}>
              <div style={{ fontFamily: F.display, fontStyle: "italic", fontSize: 15, color: C.inkSoft }}>{t("kit.noItems")}</div>
              <div style={{ marginTop: 4, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>{t("kit.noItemsHint")}</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {kitItems.map((it) => (
                <span key={it.id} style={{ padding: "4px 10px", fontFamily: F.mono, fontSize: 11, letterSpacing: "0.05em", border: `1px solid ${C.ink}`, background: C.paperDeep }}>
                  {it.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Edit mode: full inventory checklist */}
      {editing && (
        <div style={{ marginTop: 16, padding: 16, background: C.paperDeep, border: `1px dashed ${C.ink}` }}>
          <div style={{ marginBottom: 12, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
            {t("kit.allItems")}
          </div>
          {items.length === 0 ? (
            <div style={{ padding: 12, fontFamily: F.body, fontSize: 13, color: C.muted, fontStyle: "italic" }}>
              {t("kit.noInventory")}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 280, overflowY: "auto", paddingRight: 4 }}>
              {items.map((it) => {
                const inKit = isInKit(it.id);
                return (
                  <button
                    key={it.id}
                    onClick={() => toggleItem(it.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "8px 12px",
                      background: inKit ? C.paper : "transparent",
                      border: `1.5px solid ${inKit ? C.forest : C.line}`,
                      cursor: "pointer",
                      textAlign: "left",
                      width: "100%",
                    }}
                  >
                    <span style={{
                      width: 20, height: 20, flexShrink: 0,
                      border: `1.5px solid ${inKit ? C.forest : C.muted}`,
                      background: inKit ? C.forest : "transparent",
                      color: C.paper,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                    }}>
                      {inKit && <Check size={12} strokeWidth={3} />}
                    </span>
                    <span style={{ flex: 1, fontFamily: F.body, fontSize: 14, fontWeight: 500, color: C.ink }}>{it.name}</span>
                    <span style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                      {tOrLiteral(lang, "cat", it.category)}  /  {formatWeight(it.weight, units)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Edit items toggle */}
      <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
        <Btn
          variant={editing ? "rust" : "ghost"}
          icon={editing ? Check : Plus}
          onClick={() => setEditing(!editing)}
          fullWidth={isMobile}
        >
          {editing ? t("kit.done") : t("kit.editItems")}
        </Btn>
      </div>

      {/* Delete confirmation overlay */}
      {confirming && (
        <div style={{ marginTop: 16, padding: 16, background: C.paperDeep, border: `1.5px dashed ${C.rust}` }}>
          <div style={{ fontFamily: F.body, fontSize: 14, color: C.inkSoft, marginBottom: 12 }}>
            {t("kit.confirmDelete")}
          </div>
          <div style={{ display: "flex", gap: 8, flexDirection: isMobile ? "column-reverse" : "row" }}>
            <Btn variant="ghost" icon={X} onClick={() => setConfirming(false)} fullWidth={isMobile}>{t("common.cancel")}</Btn>
            <Btn variant="rust" icon={Trash2} onClick={() => onDelete(kit.id)} fullWidth={isMobile}>{t("kit.confirmYes")}</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

function KitsView({ kits, items, categories, onUpdateKit, onDeleteKit, onShareKit, onPublishKit, onEditKit, packlists, setPacklists }) {
  const { t, lang, units } = useI18n();
  const { isMobile } = useViewport();
  // Collapse-by-default state per kit. expanded[kitId] = true means show items.
  const [expanded, setExpanded] = useState({});
  const toggleExpanded = (id) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  if (kits.length === 0) return <EmptyState label={t("kit.empty")} hint={t("kit.emptyHint")} />;

  // Group kits by their `category` field. Kits with the same category appear
  // under one heading. Kits without a category go into a "No category" group
  // shown last. Categories are ordered by the `categories` array (which is
  // typically the order the user created them) with unknowns at the end.
  const byCategory = new Map(); // categoryName | "" -> [kits]
  kits.forEach((k) => {
    const key = k.category || "";
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(k);
  });

  // Build an ordered list: known categories first (in `categories` order),
  // then any categories not in the array, then the no-category bucket last.
  const orderedGroups = [];
  const seenKeys = new Set();
  categories.forEach((c) => {
    if (byCategory.has(c.name)) {
      orderedGroups.push({ categoryName: c.name, kits: byCategory.get(c.name) });
      seenKeys.add(c.name);
    }
  });
  byCategory.forEach((arr, key) => {
    if (key === "" || seenKeys.has(key)) return;
    orderedGroups.push({ categoryName: key, kits: arr });
    seenKeys.add(key);
  });
  if (byCategory.has("")) {
    orderedGroups.push({ categoryName: null, kits: byCategory.get("") });
  }

  // Render one kit (the original card body) — extracted so we can call it
  // inside each category group.
  const renderKit = (kit) => {
    const kitItems = (kit.itemIds || []).map((id) => items.find((i) => i.id === id)).filter(Boolean);
    const kitKg = kitItems.reduce((s, i) => s + parseKg(i.weight || ""), 0);
    const kitWeightStr = formatWeightFromKg(kitKg, units);
    return (
      <div key={kit.id}>
            {/* Header row — name + meta on left, action icons on right.
                Tapping the name area toggles the items list below. */}
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              marginBottom: 8, paddingBottom: 8,
              borderBottom: `1.5px solid ${C.ink}`,
            }}>
              <button
                onClick={() => toggleExpanded(kit.id)}
                style={{
                  flex: 1, minWidth: 0, textAlign: "left",
                  background: "none", border: "none", padding: 0, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 8,
                }}>
                <ChevronRight
                  size={16}
                  strokeWidth={2}
                  color={C.muted}
                  style={{ flexShrink: 0, transform: expanded[kit.id] ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: F.display, fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", color: C.ink }}>
                    {kit.name}
                  </div>
                  <div style={{ marginTop: 2, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                    KIT · {kitItems.length} {kitItems.length === 1 ? "item" : "items"} · {kitWeightStr}
                    {kit.category ? ` · ${tOrLiteral(lang, "cat", kit.category)}` : ""}
                  </div>
                </div>
              </button>
              {/* Action icons — share, publish, edit, delete */}
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                {onShareKit && (
                  <button onClick={() => onShareKit(kit)}
                    style={{ width: 30, height: 30, background: C.paperDeep, border: `1px solid ${C.ink}`, color: C.ink, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                    title={t("share.btn")} aria-label={t("share.btn")}>
                    <ChevronRight size={13} style={{ transform: "rotate(-45deg)" }} />
                  </button>
                )}
                {onPublishKit && (
                  <button onClick={() => onPublishKit(kit)}
                    style={{ width: 30, height: 30, background: C.paperDeep, border: `1px solid ${C.forest}`, color: C.forest, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                    title={t("lib.publishBtn")} aria-label={t("lib.publishBtn")}>
                    <Globe size={13} />
                  </button>
                )}
                {onEditKit && (
                  <button onClick={() => onEditKit(kit.id)}
                    style={{ width: 30, height: 30, background: C.paperDeep, border: `1px solid ${C.ink}`, color: C.ink, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                    title={t("pl.editBtn")} aria-label={t("pl.editBtn")}>
                    <Pencil size={13} />
                  </button>
                )}
                <button onClick={() => onDeleteKit(kit.id)}
                  style={{ width: 30, height: 30, background: C.paperDeep, border: `1px solid ${C.rust}`, color: C.rust, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                  title={t("pl.deleteBtn")} aria-label={t("pl.deleteBtn")}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {/* Add-to-Packlist + items list — both hidden when kit is collapsed */}
            {expanded[kit.id] && (
              <>
                {packlists && setPacklists && (
                  <div style={{ marginBottom: 8 }}>
                    <AddToPacklistMenu
                      kind="kit" entityId={kit.id} entityName={kit.name}
                      packlists={packlists} setPacklists={setPacklists}
                    />
                  </div>
                )}

                {kitItems.length === 0 ? (
                  <div style={{ paddingLeft: 12, fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.inkSoft }}>
                    {t("kitDetail.empty")}
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {kitItems.map((it) => (
                      <div key={it.id}
                        style={{
                          display: "flex", alignItems: "center", gap: 10,
                          padding: "8px 12px",
                          borderBottom: `1px solid ${C.line}`,
                        }}>
                        <span style={{ flex: 1, minWidth: 0, fontFamily: F.body, fontSize: 14, color: C.ink }}>
                          {it.name}
                        </span>
                        {it.category && (
                          <span style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: C.muted }}>
                            {tOrLiteral(lang, "cat", it.category)}
                          </span>
                        )}
                        {it.weight && (
                          <span style={{ fontFamily: F.mono, fontSize: 11, color: C.muted, fontWeight: 600 }}>
                            {formatWeight(it.weight, units)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 36 }}>
      {orderedGroups.map((group, gIdx) => (
        <div key={group.categoryName || `__none__${gIdx}`}>
          {/* Big category banner header */}
          <div style={{
            marginBottom: 14, padding: "12px 16px",
            background: C.ink, color: C.paper,
          }}>
            <div style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: "0.2em", textTransform: "uppercase", opacity: 0.7, fontWeight: 700 }}>
              {t("kitsView.categoryGroup")}
            </div>
            <div style={{ marginTop: 2, fontFamily: F.display, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
              {group.categoryName ? tOrLiteral(lang, "cat", group.categoryName) : t("kitsView.noCategory")}
              <span style={{ marginLeft: 10, fontFamily: F.mono, fontSize: 11, opacity: 0.7, letterSpacing: "0.15em", fontWeight: 500 }}>
                {group.kits.length} {group.kits.length === 1 ? "kit" : "kits"}
              </span>
            </div>
          </div>
          {/* Kits in this category */}
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            {group.kits.map((kit) => renderKit(kit))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ============================================================
   CategoryDetail — drilled-in view for a single category
   showing its items + kits with full add/edit/delete
   ============================================================ */
function CategoryDetail({
  category,
  items, kits, categories,
  onAddItem, onUpdateItem, onDeleteItem, onTogglePacked,
  onAddKit, onUpdateKit, onDeleteKit,
  onBack,
}) {
  const { t, lang } = useI18n();
  const { isMobile } = useViewport();
  const [adding, setAdding] = useState(null); // null | "item" | "kit"
  const [editingItemId, setEditingItemId] = useState(null);

  const filteredItems = items.filter((it) => it.category === category.name);
  const filteredKits = kits.filter((k) => k.category === category.name);

  const itemsLabel = filteredItems.length === 1 ? t("catDetail.itemsCount_one") : t("catDetail.itemsCount_many", { n: filteredItems.length });
  const kitsLabel = filteredKits.length === 1 ? t("catDetail.kitsCount_one") : t("catDetail.kitsCount_many", { n: filteredKits.length });

  const Icon = iconFor(category.icon);

  // Wrap add/update so we can close the form after success
  const handleAddItem = (data) => {
    onAddItem(data);
    setAdding(null);
  };
  const handleAddKit = (data) => {
    onAddKit(data);
    setAdding(null);
  };
  const handleSaveEdit = (id) => (data) => {
    onUpdateItem(id, data);
    setEditingItemId(null);
  };

  const editingItem = editingItemId ? items.find((i) => i.id === editingItemId) : null;

  return (
    <div>
      {/* Header strip with back + category name */}
      <div style={{ marginBottom: 24, paddingBottom: 16, borderBottom: `1.5px solid ${C.ink}` }}>
        <button
          onClick={onBack}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            background: "none",
            border: "none",
            cursor: "pointer",
            fontFamily: F.mono,
            fontSize: 11,
            color: C.muted,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            padding: "8px 0",
            marginBottom: 12,
          }}
        >
          <ArrowLeft size={14} /> {t("inv.tabCategories")}
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <Icon size={isMobile ? 28 : 36} strokeWidth={1.4} color={C.forest} />
          <h2 style={{ margin: 0, fontFamily: F.display, fontSize: isMobile ? 32 : 44, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1 }}>
            {tOrLiteral(lang, "cat", category.name)}<span style={{ color: C.rust }}>.</span>
          </h2>
        </div>
        <div style={{ marginTop: 10, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>
          {itemsLabel}  /  {kitsLabel}
        </div>
      </div>

      {/* ITEMS section */}
      <div style={{ marginTop: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16, paddingBottom: 8, borderBottom: `1px dashed ${C.line}` }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <span style={{ fontFamily: F.display, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
              {t("catDetail.itemsHeading")}
            </span>
            <span style={{ fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>
              {filteredItems.length}
            </span>
          </div>
          <Btn
            variant={adding === "item" ? "ghost" : "rust"}
            icon={adding === "item" ? X : Plus}
            onClick={() => { setAdding(adding === "item" ? null : "item"); setEditingItemId(null); }}
            fullWidth={isMobile}
          >
            {adding === "item" ? t("common.cancel") : t("catDetail.addItem")}
          </Btn>
        </div>

        {adding === "item" && (
          <AddItemForm
            categories={categories}
            defaultCategory={category.name}
            onAdd={handleAddItem}
            onCancel={() => setAdding(null)}
          />
        )}

        {editingItem && (
          <AddItemForm
            categories={categories}
            initial={editingItem}
            onAdd={handleSaveEdit(editingItem.id)}
            onCancel={() => setEditingItemId(null)}
          />
        )}

        {filteredItems.length === 0 ? (
          <EmptyState
            label={t("catDetail.empty.items")}
            hint={t("catDetail.empty.itemsHint")}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {filteredItems.map((it, idx) => (
              <CategoryItemRow
                key={it.id}
                item={it}
                index={idx}
                onToggle={() => onTogglePacked(it.id)}
                onEdit={() => { setEditingItemId(it.id); setAdding(null); }}
                onDelete={() => onDeleteItem(it.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* KITS section */}
      <div style={{ marginTop: 40 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16, paddingBottom: 8, borderBottom: `1px dashed ${C.line}` }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <span style={{ fontFamily: F.display, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
              {t("catDetail.kitsHeading")}
            </span>
            <span style={{ fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>
              {filteredKits.length}
            </span>
          </div>
          <Btn
            variant={adding === "kit" ? "ghost" : "rust"}
            icon={adding === "kit" ? X : Plus}
            onClick={() => { setAdding(adding === "kit" ? null : "kit"); setEditingItemId(null); }}
            fullWidth={isMobile}
          >
            {adding === "kit" ? t("common.cancel") : t("catDetail.addKit")}
          </Btn>
        </div>

        {adding === "kit" && (
          <AddKitForm
            categories={categories}
            items={items}
            defaultCategory={category.name}
            onAdd={handleAddKit}
            onAddItem={onAddItem}
            onCancel={() => setAdding(null)}
          />
        )}

        {filteredKits.length === 0 ? (
          <EmptyState
            label={t("catDetail.empty.kits")}
            hint={t("catDetail.empty.kitsHint")}
          />
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 16 }}>
            {filteredKits.map((kit) => (
              <KitCard
                key={kit.id}
                kit={kit}
                items={items}
                categories={categories}
                onUpdate={onUpdateKit}
                onDelete={onDeleteKit}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Single item row used inside CategoryDetail
function CategoryItemRow({ item, index, onToggle, onEdit, onDelete }) {
  const { t, locale, lang, units } = useI18n();
  const { isMobile } = useViewport();

  const fmtExpiry = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(locale, { month: "short", year: "numeric" }).toUpperCase();
  };
  const isExpired = (iso) => {
    if (!iso) return false;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return false;
    return d.getTime() < Date.now();
  };
  const expired = item.expiry && isExpired(item.expiry);
  const meta = [];
  if (item.quantity && item.quantity > 1) meta.push(`${t("inv.metaQty")} ${item.quantity}`);
  if (item.size) meta.push(`${t("inv.metaSize")} ${item.size}`);
  if (item.expiry) meta.push(`${t("inv.metaExp")} ${fmtExpiry(item.expiry)}`);

  return (
    <div style={{ background: C.paper, border: `1.5px solid ${C.ink}`, padding: 14, display: "flex", gap: 12, alignItems: "stretch" }}>
      {/* Pack toggle */}
      <button
        onClick={onToggle}
        style={{
          width: 44, minWidth: 44,
          cursor: "pointer",
          background: item.packed ? C.forest : "transparent",
          border: `1.5px solid ${item.packed ? C.forest : C.ink}`,
          color: C.paper,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          alignSelf: "stretch",
        }}
        aria-label="Pack toggle"
      >
        {item.packed && <Check size={20} strokeWidth={3} />}
      </button>

      {/* Center: name, badges, weight, meta */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.15em" }}>
          {String(index + 1).padStart(3, "0")}
        </div>
        <div style={{ marginTop: 2, fontFamily: F.display, fontSize: 17, fontWeight: 600, lineHeight: 1.2, wordBreak: "break-word" }}>
          {item.name}
        </div>
        <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <span style={{ fontFamily: F.mono, fontSize: 11, color: C.inkSoft, fontWeight: 700 }}>{formatWeight(item.weight, units)}</span>
          {item.consumable && (
            <span style={{ padding: "2px 6px", fontFamily: F.mono, fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", border: `1px solid ${C.ochre}`, color: C.ochre, fontWeight: 700 }}>
              {t("inv.badgeConsumable")}
            </span>
          )}
          {expired && (
            <span style={{ padding: "2px 6px", fontFamily: F.mono, fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", border: `1px solid ${C.rust}`, color: C.rust, fontWeight: 700 }}>
              {t("inv.badgeExpired")}
            </span>
          )}
        </div>
        {meta.length > 0 && (
          <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.05em" }}>
            {meta.join("  /  ")}
          </div>
        )}
      </div>

      {/* Edit + Delete buttons stacked */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, alignSelf: "stretch", justifyContent: "center" }}>
        <button
          onClick={onEdit}
          style={{
            width: 40, minWidth: 40, height: 36,
            cursor: "pointer",
            background: "transparent",
            border: `1px solid ${C.ink}`,
            color: C.ink,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            fontFamily: F.mono, fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700,
          }}
          aria-label={t("catDetail.edit")}
        >
          {t("catDetail.edit")}
        </button>
        <button
          onClick={onDelete}
          style={{
            width: 40, minWidth: 40, height: 36,
            cursor: "pointer",
            background: "transparent",
            border: `1px solid ${C.rust}`,
            color: C.rust,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
          }}
          aria-label="Delete"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   SendLocationDialog — modal for sending current location either
   to a PakMondo member (via existing share system) or to any
   email address (via Resend serverless function).
   ============================================================ */
function SendLocationDialog({ coords, place, fromUser, shareService, onClose }) {
  const { t, lang } = useI18n();
  const { isMobile } = useViewport();
  const [mode, setMode] = useState("member");      // "member" | "email"
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const send = async () => {
    if (sending || !recipient.trim()) return;
    setSending(true); setError(""); setSuccess("");

    const payload = {
      lat: coords.lat,
      lon: coords.lon,
      placeName: place?.full || "",
      capturedAt: new Date().toISOString(),
      mapsUrl: googleMapsUrl(coords.lat, coords.lon),
      note: note.trim(),
    };

    if (mode === "member") {
      // Send via existing share system
      if (!shareService) { setError(t("loc.sendFailed")); setSending(false); return; }
      const result = await shareService.sendShare({
        kind: "location",
        payload,
        recipientUsername: recipient.trim(),
        mode: "copy",
      });
      setSending(false);
      if (result.error) {
        setError(result.error || t("loc.sendFailed"));
        return;
      }
      setSuccess(t("loc.sentMember", { name: recipient.trim() }));
      setTimeout(onClose, 1500);
    } else {
      // Send via Vercel serverless function -> Resend
      try {
        const res = await fetch("/api/send-location-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: recipient.trim(),
            fromName: fromUser.username || fromUser.name || "A PakMondo user",
            lat: coords.lat,
            lon: coords.lon,
            placeName: place?.full || "",
            note: note.trim(),
            lang: lang,
          }),
        });
        setSending(false);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          setError(errData.error || t("loc.sendFailed"));
          return;
        }
        setSuccess(t("loc.sentEmail", { email: recipient.trim() }));
        setTimeout(onClose, 1800);
      } catch (e) {
        setSending(false);
        setError(t("loc.sendFailed"));
      }
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(26,36,33,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: "100%", maxWidth: 520, background: C.paper, border: `1.5px solid ${C.ink}`, padding: isMobile ? 20 : 28, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontFamily: F.display, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
            {t("loc.dialogTitle")}
          </h3>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: C.ink, padding: 4 }} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        {/* Coords preview */}
        <div style={{ padding: 12, background: C.paperDeep, borderLeft: `3px solid ${C.forest}`, marginBottom: 18 }}>
          <div style={{ fontFamily: F.mono, fontSize: 14, fontWeight: 700, color: C.ink }}>
            📍 {formatCoords(coords.lat, coords.lon)}
          </div>
          {place?.full && (
            <div style={{ marginTop: 4, fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.inkSoft }}>
              {place.full}
            </div>
          )}
        </div>

        {/* Mode toggle */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button onClick={() => setMode("member")}
            style={{ flex: 1, padding: "10px 12px", border: `1.5px solid ${mode === "member" ? C.forest : C.line}`, background: mode === "member" ? C.forest : "transparent", color: mode === "member" ? C.paper : C.ink, cursor: "pointer", fontFamily: F.mono, fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700 }}>
            👥 {t("loc.sendToMember")}
          </button>
          <button onClick={() => setMode("email")}
            style={{ flex: 1, padding: "10px 12px", border: `1.5px solid ${mode === "email" ? C.forest : C.line}`, background: mode === "email" ? C.forest : "transparent", color: mode === "email" ? C.paper : C.ink, cursor: "pointer", fontFamily: F.mono, fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700 }}>
            ✉ {t("loc.sendToEmail")}
          </button>
        </div>

        {/* Recipient input */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ marginBottom: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
            {mode === "member" ? t("loc.recipientUsername") : t("loc.recipientEmail")}
          </div>
          <input value={recipient} onChange={(e) => setRecipient(e.target.value)}
            placeholder={mode === "member" ? "username" : "name@example.com"}
            type={mode === "email" ? "email" : "text"}
            style={{ width: "100%", padding: "10px 0", background: "transparent", border: "none", borderBottom: `1.5px solid ${C.ink}`, outline: "none", fontFamily: F.body, fontSize: 16, color: C.ink }} />
        </div>

        {/* Note input */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ marginBottom: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
            {t("loc.optionalMessage")}
          </div>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
            placeholder=""
            style={{ width: "100%", padding: "10px 0", background: "transparent", border: "none", borderBottom: `1.5px solid ${C.ink}`, outline: "none", fontFamily: F.body, fontSize: 15, color: C.ink, resize: "vertical" }} />
        </div>

        {error && (
          <div style={{ marginBottom: 14, padding: 10, background: C.paperDeep, border: `1.5px solid ${C.rust}`, color: C.rust, fontFamily: F.body, fontSize: 13 }}>
            {error}
          </div>
        )}
        {success && (
          <div style={{ marginBottom: 14, padding: 10, background: C.paperDeep, borderLeft: `3px solid ${C.forest}`, color: C.forest, fontFamily: F.body, fontSize: 13 }}>
            ✓ {success}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexDirection: isMobile ? "column-reverse" : "row" }}>
          <Btn variant="ghost" icon={X} onClick={onClose} fullWidth={isMobile}>{t("common.cancel")}</Btn>
          <Btn variant="rust" icon={ChevronRight} onClick={send} fullWidth={isMobile} disabled={sending || !recipient.trim()}>
            {sending ? t("loc.sendingBtn") : t("loc.sendBtn")}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   ShareDialog — modal-style panel for sending a kit/category/trip
   to another user via username, share code, or file export.
   Sender chooses Copy vs Live Link mode.
   ============================================================ */
function ShareDialog({
  kind,                      // "category" | "kit" | "trip"
  entity,                    // the thing being shared
  shareService,
  currentUser,
  items, kits, categories, packlists,
  onClose,
}) {
  const { t, lang } = useI18n();
  const { isMobile } = useViewport();
  const [tab, setTab] = useState("username");   // "username" | "code" | "file"
  const [recipientInput, setRecipientInput] = useState("");
  const [mode, setMode] = useState("copy");
  const [includeOptions, setIncludeOptions] = useState({
    includeItems: true,        // for category: ship items along
    includePacklist: true,     // for trip
    includeKits: true,         // for trip
  });
  const [generatedCode, setGeneratedCode] = useState("");
  const [codeCopied, setCodeCopied] = useState(false);
  const [fileDownloaded, setFileDownloaded] = useState(false);
  const [sentTo, setSentTo] = useState(null);

  const isCategory = kind === "category";
  const isKit = kind === "kit";
  const isTrip = kind === "trip";

  const titleKey = isCategory ? "share.shareCategory" : isKit ? "share.shareKit" : "share.shareTrip";

  // Build the payload right now based on current options
  const payload = buildSharePayload({ kind, entity, options: includeOptions, items, kits, categories, packlists });

  // Username search — debounced async lookup against Supabase.
  // Re-runs whenever recipientInput changes; cancels in-flight if user types more.
  const [matched, setMatched] = useState(null);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const value = recipientInput.trim();
    if (!value) { setMatched(null); setSearching(false); return; }
    // Self-check first — synchronous
    if (currentUser?.username && currentUser.username.toLowerCase() === value.toLowerCase()) {
      setMatched({ username: currentUser.username, name: currentUser.name, region: currentUser.region, isSelf: true });
      setSearching(false);
      return;
    }
    // Async lookup with 300ms debounce + cancellation
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      const found = await supabaseService.findUser(value);
      if (cancelled) return;
      setMatched(found);
      setSearching(false);
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [recipientInput, currentUser?.username]);

  const usernameStatus = !recipientInput.trim() ? null
    : searching ? "searching"
    : matched?.isSelf ? "self"
    : matched ? "found"
    : "notfound";

  const sendByUsername = async () => {
    if (usernameStatus !== "found") return;
    const rec = await shareService.sendShare({
      kind,
      payload,
      recipientUsername: matched.username,
      mode,
    });
    if (rec) setSentTo(matched.username);
  };

  const generateCode = async () => {
    const code = generateShareCode();
    // Build the same record but mark it with the code instead of recipient
    await shareService.sendShare({
      kind,
      payload,
      recipientUsername: `code:${code}`, // namespaced so it doesn't collide
      mode,
    });
    setGeneratedCode(code);
  };

  const copyCode = () => {
    if (!generatedCode) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(generatedCode).catch(() => {});
    }
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2000);
  };

  const downloadFile = () => {
    const exportData = shareService.exportPayload({ kind, payload, mode });
    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const name = entity?.name ? entity.name.replace(/[^A-Za-z0-9_-]/g, "_") : kind;
    a.download = `pakmondo-${kind}-${name}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setFileDownloaded(true);
    setTimeout(() => setFileDownloaded(false), 2400);
  };

  // Optional includes per kind
  const includesUI = (
    <>
      {isCategory && (
        <ToggleRow
          label={t("share.includeItems")}
          hint={t("share.includeItemsHint")}
          value={includeOptions.includeItems}
          onChange={(v) => setIncludeOptions((o) => ({ ...o, includeItems: v }))}
        />
      )}
      {isTrip && (
        <>
          <ToggleRow
            label={t("share.includePacklists")}
            hint={t("share.includePacklistsHint")}
            value={includeOptions.includePacklist}
            onChange={(v) => setIncludeOptions((o) => ({ ...o, includePacklist: v }))}
          />
          <ToggleRow
            label={t("share.includeKits")}
            hint={t("share.includeKitsHint")}
            value={includeOptions.includeKits}
            onChange={(v) => setIncludeOptions((o) => ({ ...o, includeKits: v }))}
          />
        </>
      )}
    </>
  );

  return (
    <div style={{
      position: "fixed",
      inset: 0,
      background: "rgba(26,36,33,0.55)",
      zIndex: 999,
      display: "flex",
      alignItems: isMobile ? "flex-end" : "center",
      justifyContent: "center",
      padding: isMobile ? 0 : 24,
    }}
    onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 560,
          maxHeight: isMobile ? "92vh" : "88vh",
          overflowY: "auto",
          background: C.paper,
          border: `1.5px solid ${C.ink}`,
          padding: isMobile ? 20 : 28,
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
          <div>
            <Coord>{t(titleKey).toUpperCase()}</Coord>
            <h3 style={{ margin: "6px 0 2px", fontFamily: F.display, fontSize: isMobile ? 22 : 28, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05 }}>
              {entity?.name || kind}<span style={{ color: C.rust }}>.</span>
            </h3>
            <div style={{ fontFamily: F.body, fontStyle: "italic", color: C.muted, fontSize: 13 }}>{t("share.dialogSub")}</div>
          </div>
          <button onClick={onClose}
            style={{ width: 36, height: 36, cursor: "pointer", background: "transparent", border: `1.5px solid ${C.ink}`, color: C.ink, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
            aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {/* Mode picker (Copy vs Live) */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ marginBottom: 8, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
            {t("share.mode")}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 8 }}>
            {[["copy", t("share.modeCopy"), t("share.modeCopyHint")],
              ["live", t("share.modeLive"), t("share.modeLiveHint")]].map(([k, label, hint]) => {
              const sel = mode === k;
              return (
                <button key={k} onClick={() => setMode(k)}
                  style={{
                    padding: 12,
                    border: `1.5px solid ${sel ? C.ink : C.line}`,
                    background: sel ? C.ink : "transparent",
                    color: sel ? C.paper : C.ink,
                    cursor: "pointer",
                    textAlign: "left",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}>
                  <span style={{ fontFamily: F.display, fontSize: 16, fontWeight: 700, letterSpacing: "-0.01em" }}>{label}</span>
                  <span style={{ fontFamily: F.body, fontSize: 11, fontStyle: "italic", opacity: 0.8 }}>{hint}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Per-kind includes */}
        {(isCategory || isTrip) && (
          <div style={{ marginBottom: 18, padding: 12, background: C.paperDeep, border: `1px dashed ${C.line}` }}>
            {includesUI}
          </div>
        )}

        {/* Tab strip for recipient method */}
        <div style={{ display: "flex", borderBottom: `1.5px solid ${C.ink}`, marginBottom: 16, overflowX: "auto" }}>
          {[["username", t("share.tabUsername")], ["code", t("share.tabCode")], ["file", t("share.tabFile")]].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              style={{
                padding: "10px 14px",
                border: "none",
                cursor: "pointer",
                fontFamily: F.mono,
                fontSize: 11,
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                fontWeight: 700,
                background: tab === k ? C.ink : "transparent",
                color: tab === k ? C.paper : C.ink,
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}>
              {l}
            </button>
          ))}
        </div>

        {/* === USERNAME tab === */}
        {tab === "username" && (
          <div>
            <Field
              label={t("share.recipient")}
              icon={User}
              value={recipientInput}
              onChange={(e) => setRecipientInput(e.target.value)}
              placeholder={t("share.usernamePh")}
            />
            {recipientInput.trim() && (
              <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, fontFamily: F.body, fontSize: 13 }}>
                {usernameStatus === "searching" && (
                  <span style={{ color: C.muted, fontStyle: "italic" }}>Searching…</span>
                )}
                {usernameStatus === "found" && (
                  <>
                    <Check size={14} strokeWidth={3} color={C.forest} />
                    <span><b>{matched.name}</b> <span style={{ color: C.muted }}>({matched.username})</span></span>
                    {matched.region && <RegionBadge code={matched.region} />}
                  </>
                )}
                {usernameStatus === "self" && (
                  <><X size={14} strokeWidth={3} color={C.rust} /><span style={{ color: C.rust }}>{t("share.cantShareSelf")}</span></>
                )}
                {usernameStatus === "notfound" && (
                  <><X size={14} strokeWidth={3} color={C.rust} /><span style={{ color: C.rust }}>{t("share.usernameNotFound")}</span></>
                )}
              </div>
            )}
            <div style={{ marginTop: 18, display: "flex", gap: 10, flexDirection: isMobile ? "column-reverse" : "row", justifyContent: isMobile ? "stretch" : "flex-end" }}>
              <Btn variant="ghost" icon={X} onClick={onClose} fullWidth={isMobile}>{t("share.cancel")}</Btn>
              <Btn
                variant="rust"
                icon={Check}
                onClick={sendByUsername}
                fullWidth={isMobile}
                disabled={usernameStatus !== "found"}
              >
                {sentTo ? t("share.sendAgain") : t("share.send")}
              </Btn>
            </div>
            {sentTo && (
              <div style={{ marginTop: 14, padding: 10, background: C.forestDeep, color: C.paper, fontFamily: F.mono, fontSize: 11, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700, textAlign: "center" }}>
                ✓ {t("share.sent")}: @{sentTo}
              </div>
            )}
          </div>
        )}

        {/* === SHARE CODE tab === */}
        {tab === "code" && (
          <div>
            <div style={{ marginBottom: 14, fontFamily: F.body, fontSize: 13, color: C.muted, fontStyle: "italic" }}>
              {t("share.codeHint")}
            </div>
            {generatedCode ? (
              <div style={{ padding: 18, background: C.ink, color: C.paper, textAlign: "center" }}>
                <div style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: "0.22em", textTransform: "uppercase", opacity: 0.7, marginBottom: 8 }}>
                  Share code
                </div>
                <div style={{ fontFamily: F.mono, fontSize: 24, fontWeight: 700, letterSpacing: "0.12em", marginBottom: 14 }}>
                  {generatedCode}
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                  <button onClick={copyCode}
                    style={{ padding: "8px 14px", background: codeCopied ? C.forest : C.rust, color: C.paper, border: "none", cursor: "pointer", fontFamily: F.mono, fontSize: 11, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700 }}>
                    {codeCopied ? `✓ ${t("share.copied")}` : t("share.copyCode")}
                  </button>
                  <button onClick={generateCode}
                    style={{ padding: "8px 14px", background: "transparent", color: C.paper, border: `1.5px solid ${C.paper}`, cursor: "pointer", fontFamily: F.mono, fontSize: 11, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700 }}>
                    {t("share.regenCode")}
                  </button>
                </div>
              </div>
            ) : (
              <Btn variant="rust" icon={Plus} onClick={generateCode} fullWidth={true}>{t("share.generateCode")}</Btn>
            )}
            <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end" }}>
              <Btn variant="ghost" icon={X} onClick={onClose} fullWidth={isMobile}>{t("share.cancel")}</Btn>
            </div>
          </div>
        )}

        {/* === FILE EXPORT tab === */}
        {tab === "file" && (
          <div>
            <div style={{ marginBottom: 14, fontFamily: F.body, fontSize: 13, color: C.muted, fontStyle: "italic" }}>
              {t("share.fileHint")}
            </div>
            <Btn variant="rust" icon={Plus} onClick={downloadFile} fullWidth={true}>
              {fileDownloaded ? `✓ ${t("share.fileDownloaded")}` : t("share.exportFile")}
            </Btn>
            <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end" }}>
              <Btn variant="ghost" icon={X} onClick={onClose} fullWidth={isMobile}>{t("share.cancel")}</Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Reusable yes/no toggle row used in share options
function ToggleRow({ label, hint, value, onChange }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: F.body, fontSize: 13, fontWeight: 600, color: C.ink }}>{label}</div>
        {hint && <div style={{ fontFamily: F.body, fontSize: 11, color: C.muted, fontStyle: "italic", marginTop: 2 }}>{hint}</div>}
      </div>
      <div style={{ display: "inline-flex", border: `1.5px solid ${C.ink}`, flexShrink: 0 }}>
        {[["off", false], ["on", true]].map(([k, v]) => {
          const sel = value === v;
          return (
            <button key={k} onClick={() => onChange(v)}
              style={{
                padding: "5px 10px",
                border: "none",
                cursor: "pointer",
                fontFamily: F.mono,
                fontSize: 9,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                fontWeight: 700,
                background: sel ? C.ink : "transparent",
                color: sel ? C.paper : C.ink,
              }}>
              {v ? "Yes" : "No"}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================
   PublishDialog — submits a kit/category/trip to the community
   library for admin review. Three fields: title, activity (with
   autocomplete + custom-create), description.
   ============================================================ */
function PublishDialog({
  kind,           // "kit" | "category" | "trip"
  entity,         // the thing being published
  currentUser,
  items, kits, categories, packlists,
  onClose,
}) {
  const { t } = useI18n();
  const { isMobile } = useViewport();

  const [title, setTitle] = useState(entity?.name || "");
  const [activity, setActivity] = useState("");
  const [activityFocused, setActivityFocused] = useState(false);
  const [description, setDescription] = useState("");
  const [knownActivities, setKnownActivities] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  // Load activity list once on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await supabaseService.fetchActivities();
      if (!cancelled) setKnownActivities(list);
    })();
    return () => { cancelled = true; };
  }, []);

  // Autocomplete: filter known activities by current input
  const activityLower = activity.trim().toLowerCase();
  const filteredActivities = activityLower
    ? knownActivities.filter((a) => a.name.toLowerCase().includes(activityLower))
    : knownActivities;
  const exactMatch = knownActivities.some((a) => a.name.toLowerCase() === activityLower);
  const showCustomOption = activityLower.length > 0 && !exactMatch;

  const validate = () => {
    if (!title.trim()) return t("lib.titleRequired");
    // activity + description are now optional
    return null;
  };

  // Build the payload to publish — same shape as ShareDialog uses
  const submit = async () => {
    const v = validate();
    if (v) { setError(v); return; }
    setSubmitting(true);
    setError("");

    // Activity is optional. If left blank we skip ensureActivity (which would
    // otherwise fail on empty input) and submit with an empty activity tag.
    let activityName = "";
    if (activity.trim()) {
      const activityResult = await supabaseService.ensureActivity(activity, currentUser.id);
      if (activityResult.error) {
        setError(activityResult.error);
        setSubmitting(false);
        return;
      }
      activityName = activityResult.name;
    }

    // Build the snapshot payload with referenced data baked in
    const payload = buildSharePayload({
      kind,
      entity,
      options: {
        includeItems: true,        // category: bring items
        includePacklist: true,     // trip: bring packlist
        includeKits: true,         // trip: bring kits
      },
      items, kits, categories, packlists,
    });

    const result = await supabaseService.publishToLibrary({
      kind,
      title,
      description,
      activity: activityName,
      payload,
      publisher: {
        id: currentUser.id,
        username: currentUser.username,
        region: currentUser.region,
      },
    });

    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setSubmitted(true);
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(26,36,33,0.55)", zIndex: 999,
      display: "flex", alignItems: isMobile ? "flex-end" : "center", justifyContent: "center",
      padding: isMobile ? 0 : 24,
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: 540, maxHeight: isMobile ? "92vh" : "88vh", overflowY: "auto",
        background: C.paper, border: `1.5px solid ${C.ink}`, padding: isMobile ? 20 : 28,
      }}>
        {!submitted ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
              <div>
                <Coord>{t("lib.publishBtn").toUpperCase()}</Coord>
                <h3 style={{ margin: "6px 0 2px", fontFamily: F.display, fontSize: isMobile ? 22 : 26, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05 }}>
                  {t("lib.dialogTitle")}<span style={{ color: C.rust }}>.</span>
                </h3>
                <div style={{ fontFamily: F.body, fontStyle: "italic", color: C.muted, fontSize: 13, marginTop: 4 }}>{t("lib.dialogSub")}</div>
              </div>
              <button onClick={onClose}
                style={{ width: 36, height: 36, cursor: "pointer", background: "transparent", border: `1.5px solid ${C.ink}`, color: C.ink, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <X size={16} />
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 18, marginTop: 18 }}>

              {/* Title */}
              <div>
                <Field label={t("lib.fieldTitle")} icon={Tag} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={entity?.name || ""} />
                <div style={{ marginTop: 4, fontFamily: F.body, fontSize: 11, fontStyle: "italic", color: C.muted }}>{t("lib.fieldTitleHint")}</div>
              </div>

              {/* Activity with autocomplete */}
              <div style={{ position: "relative" }}>
                <Field label={`${t("lib.fieldActivity")} ${t("lib.optionalSuffix")}`} icon={Mountain} value={activity}
                  onChange={(e) => setActivity(e.target.value)}
                  onFocus={() => setActivityFocused(true)}
                  onBlur={() => setTimeout(() => setActivityFocused(false), 200)}
                  placeholder={t("lib.activityPh")} />
                <div style={{ marginTop: 4, fontFamily: F.body, fontSize: 11, fontStyle: "italic", color: C.muted }}>{t("lib.fieldActivityHint")}</div>

                {/* Autocomplete dropdown */}
                {activityFocused && (filteredActivities.length > 0 || showCustomOption) && (
                  <div style={{
                    position: "absolute",
                    top: "calc(100% + 4px)", left: 0, right: 0,
                    maxHeight: 220, overflowY: "auto",
                    background: C.paper, border: `1.5px solid ${C.ink}`,
                    zIndex: 10,
                  }}>
                    {filteredActivities.slice(0, 12).map((a) => (
                      <button key={a.id || a.name} onClick={() => { setActivity(a.name); setActivityFocused(false); }}
                        style={{
                          display: "block", width: "100%", textAlign: "left",
                          padding: "10px 14px", border: "none",
                          borderBottom: `1px dashed ${C.line}`,
                          background: "transparent", cursor: "pointer",
                          fontFamily: F.body, fontSize: 14,
                        }}>
                        {a.name}
                        {!a.is_default && <span style={{ marginLeft: 8, fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.1em" }}>· custom</span>}
                      </button>
                    ))}
                    {showCustomOption && (
                      <button onClick={() => setActivityFocused(false)}
                        style={{
                          display: "block", width: "100%", textAlign: "left",
                          padding: "10px 14px", border: "none",
                          background: C.paperDeep, cursor: "pointer",
                          fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.rust,
                        }}>
                        + {t("lib.activityCustomLabel", { name: activity.trim() })}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Description */}
              <label style={{ display: "block" }}>
                <div style={{ marginBottom: 8, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
                  {t("lib.fieldDescription")} {t("lib.optionalSuffix")}
                </div>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)}
                  placeholder={t("lib.descriptionPh")} rows={4}
                  style={{
                    width: "100%", padding: "10px 0", background: "transparent", border: "none",
                    borderBottom: `1.5px solid ${C.ink}`, outline: "none",
                    fontFamily: F.body, fontSize: 16, color: C.ink, resize: "vertical",
                  }} />
                <div style={{ marginTop: 4, fontFamily: F.body, fontSize: 11, fontStyle: "italic", color: C.muted }}>{t("lib.fieldDescriptionHint")}</div>
              </label>

              {error && (
                <div style={{ padding: 10, background: C.paperDeep, border: `1.5px solid ${C.rust}`, color: C.rust, fontFamily: F.body, fontSize: 13 }}>
                  {error}
                </div>
              )}

              <div style={{ display: "flex", gap: 10, flexDirection: isMobile ? "column-reverse" : "row", justifyContent: "flex-end", marginTop: 4 }}>
                <Btn variant="ghost" icon={X} onClick={onClose} fullWidth={isMobile}>{t("lib.cancel")}</Btn>
                <Btn variant="rust" icon={Check} onClick={submit} fullWidth={isMobile} disabled={submitting}>
                  {submitting ? t("lib.submitting") : t("lib.submit")}
                </Btn>
              </div>
            </div>
          </>
        ) : (
          <>
            <Stamp rotate={-3} color={C.forest}>SUBMITTED</Stamp>
            <h3 style={{ margin: "16px 0 10px", fontFamily: F.display, fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em" }}>
              {t("lib.submitted")}
            </h3>
            <Btn variant="rust" icon={Check} onClick={onClose} fullWidth={true}>{t("lib.cancel").replace("Cancel", "Close").replace("Cancelar", "Cerrar")}</Btn>
          </>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   ImportDialog — bulk import items / kits / categories from
   an XLSX or CSV file. Three-stage flow:
     1) Pick file (or download template)
     2) Preview parsed contents + any errors
     3) Confirm → adds everything to existing inventory
   ============================================================ */
function ImportDialog({
  existingItems, existingKits, existingCategories,
  setItems, setKits, setCategories,
  onClose,
}) {
  const { t } = useI18n();
  const { isMobile } = useViewport();
  const [stage, setStage] = useState("pick"); // "pick" | "loading" | "preview" | "saving" | "done"
  const [parsed, setParsed] = useState(null); // { items, kits, categories, errors }
  const [error, setError] = useState("");

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStage("loading");
    setError("");
    try {
      const result = await parseInventoryImport(file);
      setParsed(result);
      setStage("preview");
    } catch (err) {
      setError(err.message || t("import.parseError"));
      setStage("pick");
    }
  };

  const handleDownloadTemplate = async () => {
    try {
      await downloadImportTemplate();
    } catch (err) {
      setError(err.message || t("import.templateError"));
    }
  };

  const handleConfirm = () => {
    if (!parsed) return;
    setStage("saving");

    // === CATEGORIES ===
    // Skip ones whose names already exist (case-insensitive)
    const existingCatNames = new Set(existingCategories.map((c) => c.name.toLowerCase()));
    const newCategories = parsed.categories.filter((c) => !existingCatNames.has(c.name.toLowerCase()));

    // === ITEMS ===
    // Skip ones whose names already exist (case-insensitive, exact)
    const existingItemNames = new Set(existingItems.map((i) => i.name.toLowerCase()));
    const newItems = parsed.items.filter((i) => !existingItemNames.has(i.name.toLowerCase()));

    // === KITS ===
    // Each parsed kit already has itemIds pointing to ids inside parsed.items.
    // BUT if any of those parsed items got skipped as duplicates, we need to
    // re-point the kit to the existing item with that name. So we build a
    // name→id map across (newly-imported + existing) items.
    const parsedItemIdToName = new Map(parsed.items.map((it) => [it.id, it.name]));
    const finalNameToId = new Map();
    newItems.forEach((it) => { finalNameToId.set(it.name.toLowerCase(), it.id); });
    existingItems.forEach((it) => {
      const k = it.name.toLowerCase();
      if (!finalNameToId.has(k)) finalNameToId.set(k, it.id);
    });

    // Skip kits whose names already exist (case-insensitive)
    const existingKitNames = new Set(existingKits.map((k) => k.name.toLowerCase()));
    const newKits = parsed.kits
      .filter((k) => !existingKitNames.has(k.name.toLowerCase()))
      .map((k) => {
        const resolvedItemIds = (k.itemIds || [])
          .map((parsedId) => {
            const name = parsedItemIdToName.get(parsedId);
            if (!name) return null;
            return finalNameToId.get(name.toLowerCase()) || null;
          })
          .filter(Boolean);
        return { ...k, itemIds: resolvedItemIds };
      });

    // Apply to state — synced setters push to Supabase automatically
    if (newCategories.length) setCategories([...newCategories, ...existingCategories]);
    if (newItems.length)      setItems([...newItems, ...existingItems]);
    if (newKits.length)       setKits([...newKits, ...existingKits]);

    setStage("done");
    setParsed({
      ...parsed,
      summary: {
        addedItems: newItems.length,
        addedKits: newKits.length,
        addedCategories: newCategories.length,
        skippedItems: parsed.items.length - newItems.length,
        skippedKits: parsed.kits.length - newKits.length,
        skippedCategories: parsed.categories.length - newCategories.length,
      },
    });
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(26,36,33,0.55)",
      zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        width: "100%", maxWidth: 640, background: C.paper,
        border: `1.5px solid ${C.ink}`, padding: isMobile ? 18 : 28,
        maxHeight: "90vh", overflowY: "auto",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.2em", textTransform: "uppercase" }}>
              {t("import.heading")}
            </div>
            <h3 style={{ margin: "4px 0 0", fontFamily: F.display, fontSize: isMobile ? 24 : 28, fontWeight: 700, letterSpacing: "-0.02em" }}>
              {t("import.title")}<span style={{ color: C.rust }}>.</span>
            </h3>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: C.ink, padding: 4 }} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        {/* === PICK FILE === */}
        {stage === "pick" && (
          <div>
            <p style={{ margin: "0 0 18px", fontFamily: F.body, fontSize: 14, color: C.inkSoft, lineHeight: 1.5 }}>
              {t("import.intro")}
            </p>

            {/* Step A: download template */}
            <div style={{ marginBottom: 14, padding: 14, background: C.paperDeep, borderLeft: `3px solid ${C.ochre}` }}>
              <div style={{ marginBottom: 8, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
                {t("import.stepA")}
              </div>
              <div style={{ marginBottom: 10, fontFamily: F.body, fontSize: 14, color: C.inkSoft }}>
                {t("import.templateHint")}
              </div>
              <Btn variant="ghost" icon={Download} onClick={handleDownloadTemplate}>
                {t("import.downloadTemplate")}
              </Btn>
            </div>

            {/* Step B: upload file */}
            <div style={{ marginBottom: 14, padding: 14, background: C.paperDeep, borderLeft: `3px solid ${C.forest}` }}>
              <div style={{ marginBottom: 8, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
                {t("import.stepB")}
              </div>
              <div style={{ marginBottom: 10, fontFamily: F.body, fontSize: 14, color: C.inkSoft }}>
                {t("import.fileHint")}
              </div>
              <label style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                padding: "10px 16px", background: C.rust, color: C.paper,
                cursor: "pointer", fontFamily: F.mono, fontSize: 11,
                letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700,
                border: `1.5px solid ${C.rust}`,
              }}>
                <Plus size={14} strokeWidth={2.5} /> {t("import.chooseFile")}
                <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFileChange} style={{ display: "none" }} />
              </label>
            </div>

            {error && (
              <div style={{ marginTop: 14, padding: 12, background: C.paperDeep, border: `1.5px solid ${C.rust}`, color: C.rust, fontFamily: F.body, fontSize: 13 }}>
                ⚠ {error}
              </div>
            )}
          </div>
        )}

        {/* === LOADING === */}
        {stage === "loading" && (
          <div style={{ padding: 24, textAlign: "center" }}>
            <div style={{ fontFamily: F.display, fontStyle: "italic", fontSize: 18, color: C.inkSoft }}>
              {t("import.loading")}
            </div>
          </div>
        )}

        {/* === PREVIEW === */}
        {stage === "preview" && parsed && (
          <div>
            <p style={{ margin: "0 0 14px", fontFamily: F.body, fontSize: 14, color: C.inkSoft }}>
              {t("import.previewIntro")}
            </p>

            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: 8, marginBottom: 14 }}>
              <PreviewStat label={t("inv.tabItems")}      count={parsed.items.length} />
              <PreviewStat label={t("inv.tabKits")}       count={parsed.kits.length} />
              <PreviewStat label={t("inv.tabCategories")} count={parsed.categories.length} />
            </div>

            {/* Errors / warnings */}
            {parsed.errors.length > 0 && (
              <div style={{ marginBottom: 14, padding: 12, background: C.paperDeep, border: `1.5px solid ${C.rust}` }}>
                <div style={{ marginBottom: 6, fontFamily: F.mono, fontSize: 10, color: C.rust, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
                  {t("import.warnings")} ({parsed.errors.length})
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontFamily: F.body, fontSize: 13, color: C.inkSoft }}>
                  {parsed.errors.slice(0, 8).map((err, i) => (<li key={i}>{err}</li>))}
                  {parsed.errors.length > 8 && <li style={{ fontStyle: "italic" }}>…{parsed.errors.length - 8} more</li>}
                </ul>
              </div>
            )}

            {/* Sample item names */}
            {parsed.items.length > 0 && (
              <div style={{ marginBottom: 12, padding: 12, background: C.paperDeep, borderLeft: `3px solid ${C.forest}` }}>
                <div style={{ marginBottom: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
                  {t("import.samplePreview")}
                </div>
                <div style={{ fontFamily: F.body, fontSize: 13, color: C.ink, lineHeight: 1.5 }}>
                  {parsed.items.slice(0, 5).map((it) => it.name).join(", ")}
                  {parsed.items.length > 5 && ` +${parsed.items.length - 5} more`}
                </div>
              </div>
            )}

            <div style={{ marginTop: 18, display: "flex", gap: 8, justifyContent: "flex-end", flexDirection: isMobile ? "column-reverse" : "row" }}>
              <Btn variant="ghost" icon={X} onClick={() => { setStage("pick"); setParsed(null); }} fullWidth={isMobile}>
                {t("import.startOver")}
              </Btn>
              <Btn variant="rust" icon={Check} onClick={handleConfirm} fullWidth={isMobile}>
                {t("import.confirm")}
              </Btn>
            </div>
          </div>
        )}

        {/* === DONE === */}
        {stage === "done" && parsed?.summary && (
          <div>
            <div style={{ marginBottom: 14, padding: 14, background: C.paperDeep, borderLeft: `3px solid ${C.forest}` }}>
              <div style={{ fontFamily: F.display, fontSize: 18, fontWeight: 700, color: C.forest, marginBottom: 6 }}>
                ✓ {t("import.successTitle")}
              </div>
              <div style={{ fontFamily: F.body, fontSize: 14, color: C.ink, lineHeight: 1.6 }}>
                {t("import.summaryAdded", { i: parsed.summary.addedItems, k: parsed.summary.addedKits, c: parsed.summary.addedCategories })}
                {(parsed.summary.skippedItems + parsed.summary.skippedKits + parsed.summary.skippedCategories) > 0 && (
                  <div style={{ marginTop: 6, fontStyle: "italic", color: C.inkSoft, fontSize: 13 }}>
                    {t("import.summarySkipped", { i: parsed.summary.skippedItems, k: parsed.summary.skippedKits, c: parsed.summary.skippedCategories })}
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn variant="rust" icon={Check} onClick={onClose} fullWidth={isMobile}>{t("common.done")}</Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* Small preview-stat tile shown in the import preview stage */
function PreviewStat({ label, count }) {
  return (
    <div style={{ padding: 12, background: C.paper, border: `1.5px solid ${C.line}`, textAlign: "center" }}>
      <div style={{ fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 700 }}>{label}</div>
      <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 28, fontWeight: 700, color: C.ink }}>{count}</div>
    </div>
  );
}

function Inventory({ go, items, setItems, categories, setCategories, travelTypes, setTravelTypes, kits, setKits, packlists, setPacklists, cart, setCart, shareService, currentUser, filter, clearFilter }) {
  const { t } = useI18n();
  const { isMobile } = useViewport();
  const [tab, setTab] = useState("items");
  const [adding, setAdding] = useState(false);
  const [openCategoryId, setOpenCategoryId] = useState(null);
  // Share dialog state — { kind, entity } or null
  const [sharing, setSharing] = useState(null);
  // Publish dialog state — { kind, entity } or null
  const [publishing, setPublishing] = useState(null);
  // Modal-edit state — open when user taps a name
  const [editingItemId, setEditingItemId] = useState(null);
  const [editingKitId, setEditingKitId] = useState(null);
  const [editingCategoryId, setEditingCategoryId] = useState(null);
  // Bulk import dialog (XLSX/CSV)
  const [importingFile, setImportingFile] = useState(false);

  useEffect(() => {
    if (filter === "expiring") setTab("items");
  }, [filter]);

  const togglePacked = (id) => setItems(items.map((i) => (i.id === id ? { ...i, packed: !i.packed } : i)));
  const addItem = (data) => { setItems([{ id: uid("it"), packed: false, ...data }, ...items]); setAdding(false); };
  const updateItem = (id, data) => setItems(items.map((i) => (i.id === id ? { ...i, ...data } : i)));
  const deleteItem = (id) => {
    setItems(items.filter((i) => i.id !== id));
    // Cascade: remove from any kits referencing it
    setKits(kits.map((k) => k.itemIds.includes(id) ? { ...k, itemIds: k.itemIds.filter((x) => x !== id) } : k));
    // Cascade: remove from any packlists referencing it
    setPacklists(packlists.map((p) => p.itemIds.includes(id) ? { ...p, itemIds: p.itemIds.filter((x) => x !== id) } : p));
  };
  const addCategory = (data) => { setCategories([{ id: uid("cat"), count: 0, icon: "tag", ...data }, ...categories]); setAdding(false); };
  const updateCategory = (id, data) => setCategories(categories.map((c) => (c.id === id ? { ...c, ...data } : c)));
  const deleteCategory = (id) => {
    const cat = categories.find((c) => c.id === id);
    setCategories(categories.filter((c) => c.id !== id));
    // Any kit assigned to this category becomes uncategorized
    if (cat) {
      setKits(kits.map((k) => k.category === cat.name ? { ...k, category: null } : k));
    }
    // If the deleted category was open, close the detail view
    if (openCategoryId === id) setOpenCategoryId(null);
  };
  const addTravelType = (data) => { setTravelTypes([{ id: uid("tt"), icon: "mountain", ...data }, ...travelTypes]); setAdding(false); };
  const deleteTravelType = (id) => setTravelTypes(travelTypes.filter((tt) => tt.id !== id));
  const addKit = (data) => { setKits([{ id: uid("kit"), ...data }, ...kits]); setAdding(false); };
  const updateKit = (next) => setKits(kits.map((k) => (k.id === next.id ? next : k)));
  const deleteKit = (id) => {
    setKits(kits.filter((k) => k.id !== id));
    // Cascade: remove this kit from any packlists referencing it
    setPacklists(packlists.map((p) => p.kitIds.includes(id) ? { ...p, kitIds: p.kitIds.filter((x) => x !== id) } : p));
  };

  const switchTab = (k) => { setTab(k); setAdding(false); setOpenCategoryId(null); };
  const addLabel = tab === "items" ? t("inv.addItem") : tab === "categories" ? t("inv.addCategory") : tab === "cart" ? t("cart.add") : t("inv.addKit");

  const filteredItems = filter === "expiring" ? getExpiryAlerts(items) : items;
  const filterActive = filter === "expiring" && tab === "items";
  const filterSubKey = filteredItems.length === 1 ? "inv.filterSub_one" : "inv.filterSub_many";

  return (
    <div>
      <Header go={go} active="inventory" />
      <div style={{ padding: padX(isMobile) }}>
        <div style={{ marginTop: isMobile ? 24 : 40 }}>
          <Coord>{t("inv.section")}</Coord>
          <h1 style={{ margin: "12px 0", fontFamily: F.display, fontSize: "clamp(36px, 6vw, 72px)", fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 0.95 }}>
            {t("inv.titleA")} <span style={{ fontStyle: "italic", color: C.forest }}>{t("inv.titleB")}</span><span style={{ color: C.rust }}>.</span>
          </h1>
        </div>

        {filterActive && (
          <div style={{ marginTop: 20, padding: 14, background: C.paperDeep, border: `1.5px solid ${C.rust}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
              <AlertBadge count={filteredItems.length} size={26} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: F.mono, fontSize: 10, color: C.rust, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 700 }}>
                  {t("inv.filterTitle")}
                </div>
                <div style={{ fontFamily: F.display, fontSize: isMobile ? 15 : 18, fontWeight: 700, color: C.ink, lineHeight: 1.2 }}>
                  {t(filterSubKey, { n: filteredItems.length })}
                </div>
              </div>
            </div>
            <Btn variant="ghost" icon={X} onClick={clearFilter} fullWidth={isMobile}>{t("inv.showAll")}</Btn>
          </div>
        )}

        <div style={{ marginTop: isMobile ? 24 : 40, display: "flex", flexDirection: isMobile ? "column" : "row", justifyContent: "space-between", alignItems: isMobile ? "stretch" : "flex-end", gap: isMobile ? 14 : 16 }}>
          <div
            style={{
              display: "flex",
              borderBottom: `1.5px solid ${C.ink}`,
              overflowX: "auto",
              WebkitOverflowScrolling: "touch",
              scrollbarWidth: "none",
              flexWrap: isMobile ? "nowrap" : "wrap",
            }}
          >
            {[["items", t("inv.tabItems")], ["categories", t("inv.tabCategories")], ["kits", t("inv.tabKits")], ["cart", t("nav.cart")]].map(([k, l]) => (
              <button key={k} onClick={() => switchTab(k)}
                style={{ padding: isMobile ? "10px 14px" : "12px 20px", border: "none", cursor: "pointer", fontFamily: F.mono, fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", background: tab === k ? C.ink : "transparent", color: tab === k ? C.paper : C.ink, fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 }}>
                {l}
              </button>
            ))}
          </div>
          {!(tab === "categories" && openCategoryId) && (
            <div style={{ display: "flex", gap: 8, flexDirection: isMobile ? "column" : "row" }}>
              <Btn variant="ghost" icon={Download} onClick={() => setImportingFile(true)} fullWidth={isMobile}>
                {t("import.button")}
              </Btn>
              <Btn variant={adding ? "ghost" : "rust"} icon={adding ? X : Plus} onClick={() => setAdding(!adding)} fullWidth={isMobile}>
                {adding ? t("common.cancel") : addLabel}
              </Btn>
            </div>
          )}
        </div>
        <div style={{ marginTop: isMobile ? 20 : 32 }}>
          {tab === "items" && <>{adding && <AddItemForm categories={categories} onAdd={addItem} onCancel={() => setAdding(false)} />}<ItemsView items={filteredItems} onToggle={togglePacked} onDelete={deleteItem} onEdit={(id) => setEditingItemId(id)} emptyLabel={filterActive ? t("inv.emptyFilter") : undefined} emptyHint={filterActive ? t("inv.emptyFilterHint") : undefined} packlists={packlists} setPacklists={setPacklists} categories={categories} kits={kits} /></>}
          {tab === "categories" && (() => {
            const openCategory = openCategoryId ? categories.find((c) => c.id === openCategoryId) : null;
            if (openCategory) {
              return (
                <CategoryDetail
                  category={openCategory}
                  items={items}
                  kits={kits}
                  categories={categories}
                  onAddItem={addItem}
                  onUpdateItem={updateItem}
                  onDeleteItem={deleteItem}
                  onTogglePacked={togglePacked}
                  onAddKit={addKit}
                  onUpdateKit={updateKit}
                  onDeleteKit={deleteKit}
                  onBack={() => setOpenCategoryId(null)}
                />
              );
            }
            return (
              <>
                {adding && <AddCategoryForm onAdd={addCategory} onCancel={() => setAdding(false)} />}
                <CategoriesView
                  categories={categories}
                  items={items}
                  kits={kits}
                  onDelete={deleteCategory}
                  onOpen={(c) => setOpenCategoryId(c.id)}
                  onShare={shareService ? (c) => setSharing({ kind: "category", entity: c }) : null}
                  onPublish={currentUser?.id ? (c) => setPublishing({ kind: "category", entity: c }) : null}
                  onEdit={(id) => setEditingCategoryId(id)}
                  packlists={packlists}
                  setPacklists={setPacklists}
                />
              </>
            );
          })()}
          {tab === "kits" && <>{adding && <AddKitForm categories={categories} items={items} onAdd={addKit} onAddItem={addItem} onCancel={() => setAdding(false)} />}<KitsView kits={kits} items={items} categories={categories} onUpdateKit={updateKit} onDeleteKit={deleteKit} onShareKit={(kit) => setSharing({ kind: "kit", entity: kit })} onPublishKit={currentUser?.id ? (kit) => setPublishing({ kind: "kit", entity: kit }) : null} onEditKit={(id) => setEditingKitId(id)} packlists={packlists} setPacklists={setPacklists} /></>}
          {tab === "cart" && <CartPanel cart={cart} setCart={setCart} adding={adding} setAdding={setAdding} />}
        </div>
      </div>
      <Footer />
      {sharing && shareService && (
        <ShareDialog
          kind={sharing.kind}
          entity={sharing.entity}
          shareService={shareService}
          currentUser={currentUser}
          items={items}
          kits={kits}
          categories={categories}
          packlists={packlists}
          onClose={() => setSharing(null)}
        />
      )}
      {publishing && currentUser?.id && (
        <PublishDialog
          kind={publishing.kind}
          entity={publishing.entity}
          currentUser={currentUser}
          items={items}
          kits={kits}
          categories={categories}
          packlists={packlists}
          onClose={() => setPublishing(null)}
        />
      )}
      {importingFile && (
        <ImportDialog
          existingItems={items}
          existingKits={kits}
          existingCategories={categories}
          setItems={setItems}
          setKits={setKits}
          setCategories={setCategories}
          onClose={() => setImportingFile(false)}
        />
      )}

      {/* Modal: edit Item — opens when user taps an item name */}
      {editingItemId && (() => {
        const it = items.find((x) => x.id === editingItemId);
        if (!it) return null;
        return (
          <Modal title={t("form.editItemTitle")} onClose={() => setEditingItemId(null)}>
            <AddItemForm
              categories={categories}
              initial={it}
              onAdd={(data) => { updateItem(editingItemId, data); setEditingItemId(null); }}
              onCancel={() => setEditingItemId(null)}
            />
          </Modal>
        );
      })()}

      {/* Modal: edit Kit */}
      {editingKitId && (() => {
        const k = kits.find((x) => x.id === editingKitId);
        if (!k) return null;
        return (
          <Modal title={t("kit.editFormTitle")} onClose={() => setEditingKitId(null)}>
            <AddKitForm
              categories={categories}
              items={items}
              initial={k}
              onAdd={(data) => { updateKit({ ...k, ...data }); setEditingKitId(null); }}
              onAddItem={addItem}
              onCancel={() => setEditingKitId(null)}
            />
          </Modal>
        );
      })()}

      {/* Modal: edit Category */}
      {editingCategoryId && (() => {
        const c = categories.find((x) => x.id === editingCategoryId);
        if (!c) return null;
        return (
          <Modal title={t("form.editCatTitle")} onClose={() => setEditingCategoryId(null)}>
            <AddCategoryForm
              initial={c}
              onAdd={(data) => { updateCategory(editingCategoryId, data); setEditingCategoryId(null); }}
              onCancel={() => setEditingCategoryId(null)}
            />
          </Modal>
        );
      })()}
    </div>
  );
}

function SavedTrips({ trips, onDelete, onPlan, onShare, onPublish }) {
  const { t, lang } = useI18n();
  const { isMobile } = useViewport();
  if (trips.length === 0) {
    return (
      <div style={{ padding: isMobile ? 32 : 48, textAlign: "center", border: `1.5px dashed ${C.line}`, background: C.paperDeep }}>
        <div style={{ fontFamily: F.display, fontStyle: "italic", fontSize: isMobile ? 20 : 24, color: C.inkSoft }}>{t("trips.empty")}</div>
        <div style={{ marginTop: 8, marginBottom: 24, fontFamily: F.mono, fontSize: 11, letterSpacing: "0.15em", color: C.muted, textTransform: "uppercase" }}>{t("trips.emptyHint")}</div>
        <Btn variant="rust" icon={Plus} onClick={onPlan} fullWidth={isMobile}>{t("dash.planTrip")}</Btn>
      </div>
    );
  }

  if (isMobile) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {trips.map((tr, idx) => (
          <div key={tr.id} style={{ background: C.paper, border: `1.5px solid ${C.ink}`, padding: 16, position: "relative" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.15em" }}>
                  {String(idx + 1).padStart(3, "0")}
                </div>
                <Coord>{tr.dest}</Coord>
                <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05, wordBreak: "break-word" }}>{tr.name}</div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                {onShare && !tr.linkedFrom && (
                  <button onClick={() => onShare(tr)} style={{ width: 38, height: 38, cursor: "pointer", background: "transparent", border: `1.5px solid ${C.ink}`, color: C.ink, display: "flex", alignItems: "center", justifyContent: "center" }} aria-label={t("share.btn")} title={t("share.btn")}>
                    <ChevronRight size={14} style={{ transform: "rotate(-45deg)" }} />
                  </button>
                )}
                {onPublish && !tr.linkedFrom && (
                  <button onClick={() => onPublish(tr)} style={{ width: 38, height: 38, cursor: "pointer", background: "transparent", border: `1.5px solid ${C.forest}`, color: C.forest, display: "flex", alignItems: "center", justifyContent: "center" }} aria-label={t("lib.publishBtn")} title={t("lib.publishBtn")}>
                    <Globe size={14} />
                  </button>
                )}
                {!tr.linkedFrom && (
                  <button onClick={() => onDelete(tr.id)} style={{ width: 38, height: 38, cursor: "pointer", background: "transparent", border: `1.5px solid ${C.rust}`, color: C.rust, display: "flex", alignItems: "center", justifyContent: "center" }} aria-label="Delete trip">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
            {tr.linkedFrom && (
              <div style={{ marginTop: 8, padding: "5px 8px", background: C.paperDeep, border: `1px dashed ${C.rust}`, fontFamily: F.mono, fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: C.rust, fontWeight: 700 }}>
                {t("inbox.liveBadge")} · @{tr.linkedFrom.username}
              </div>
            )}
            <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, paddingTop: 12, borderTop: `1px dashed ${C.line}` }}>
              <div>
                <Coord>{t("trips.colDeparture")}</Coord>
                <div style={{ marginTop: 4, fontFamily: F.body, fontSize: 13 }}>{tr.date}</div>
              </div>
              <div>
                <Coord>{t("trips.colType")}</Coord>
                <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 8 }}>
                  {tr.type && <TripTypeBadge iconKey={getTripType(tr.type)?.icon || "other"} size={28} />}
                  <span style={{ fontFamily: F.body, fontSize: 13 }}>{tOrLiteral(lang, "tt", tr.type)}</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, background: C.line }}>
      {trips.map((tr, idx) => (
        <div key={tr.id} style={{ display: "grid", gridTemplateColumns: "40px 2fr 1.2fr 1fr auto", gap: 24, padding: 24, background: C.paper, alignItems: "center" }}>
          <div style={{ fontFamily: F.mono, fontSize: 12, color: C.muted }}>{String(idx + 1).padStart(3, "0")}</div>
          <div>
            <Coord>{tr.dest}</Coord>
            <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1 }}>{tr.name}</div>
            {tr.linkedFrom && (
              <div style={{ marginTop: 4, fontFamily: F.mono, fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: C.rust, fontWeight: 700 }}>
                {t("inbox.liveBadge")} · @{tr.linkedFrom.username}
              </div>
            )}
          </div>
          <div style={{ fontFamily: F.body, fontSize: 14 }}>
            <Coord>{t("trips.colDeparture")}</Coord>
            <div style={{ marginTop: 4 }}>{tr.date}</div>
          </div>
          <div style={{ fontFamily: F.body, fontSize: 14 }}>
            <Coord>{t("trips.colType")}</Coord>
            <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 8 }}>
              {tr.type && <TripTypeBadge iconKey={getTripType(tr.type)?.icon || "other"} size={28} />}
              <span>{tOrLiteral(lang, "tt", tr.type)}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {onShare && !tr.linkedFrom && (
              <button onClick={() => onShare(tr)} style={{ width: 38, height: 38, cursor: "pointer", background: "transparent", border: `1.5px solid ${C.ink}`, color: C.ink, display: "flex", alignItems: "center", justifyContent: "center" }} aria-label={t("share.btn")}>
                <ChevronRight size={14} style={{ transform: "rotate(-45deg)" }} />
              </button>
            )}
            {onPublish && !tr.linkedFrom && (
              <button onClick={() => onPublish(tr)} style={{ width: 38, height: 38, cursor: "pointer", background: "transparent", border: `1.5px solid ${C.forest}`, color: C.forest, display: "flex", alignItems: "center", justifyContent: "center" }} aria-label={t("lib.publishBtn")} title={t("lib.publishBtn")}>
                <Globe size={14} />
              </button>
            )}
            {!tr.linkedFrom && (
              <button onClick={() => onDelete(tr.id)} style={{ width: 38, height: 38, cursor: "pointer", background: "transparent", border: `1.5px solid ${C.rust}`, color: C.rust, display: "flex", alignItems: "center", justifyContent: "center" }} aria-label="Delete trip">
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function CreateTrip({
  travelTypes, onAddType, onDeleteType,
  onCreate, onCancel,
  items, setItems,
  kits, setKits,
  categories, setCategories,
  packlists, setPacklists,
}) {
  const { t, locale, lang, units } = useI18n();
  const { isMobile } = useViewport();

  // Two-step wizard
  const [step, setStep] = useState(1);

  // Step 1 — trip details (unchanged from before)
  const [form, setForm] = useState({ name: "", dest: "", start: "", end: "", type: "" });
  const [addingType, setAddingType] = useState(false);
  const [newType, setNewType] = useState({ name: "", climate: "", days: "" });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setNT = (k) => (e) => setNewType({ ...newType, [k]: e.target.value });

  // Step 2 — packing selection
  // We track categoryIds even though packlists don't have a categoryIds field today.
  // On save we expand the categories into the items they currently contain (live-link
  // semantics: live at save time; future edits would re-expand if we re-saved).
  const [pickedCategoryIds, setPickedCategoryIds] = useState([]);
  const [pickedKitIds, setPickedKitIds] = useState([]);
  const [pickedItemIds, setPickedItemIds] = useState([]);

  // Inline-create UI state
  const [inlineMode, setInlineMode] = useState(null); // "item" | "kit" | "cat" | null
  const [newItem, setNewItem] = useState({ name: "", weight: "", category: "" });
  const [newKit, setNewKit] = useState({ name: "", category: "" });
  const [newCat, setNewCat] = useState({ name: "" });
  const [searchItems, setSearchItems] = useState("");
  const [searchKits, setSearchKits] = useState("");
  const [searchCats, setSearchCats] = useState("");

  const fmt = (d) => {
    if (!d) return "";
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return d;
    return dt.toLocaleDateString(locale, { month: "short", day: "2-digit" });
  };

  // Toggling helpers
  const toggleCategory = (id) =>
    setPickedCategoryIds((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  const toggleKit = (id) =>
    setPickedKitIds((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  const toggleItem = (id) =>
    setPickedItemIds((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);

  // Filtered lists for search
  const filteredCats = searchCats.trim()
    ? categories.filter((c) => c.name.toLowerCase().includes(searchCats.toLowerCase()))
    : categories;
  const filteredKits = searchKits.trim()
    ? kits.filter((k) => k.name.toLowerCase().includes(searchKits.toLowerCase()))
    : kits;
  const filteredItems = searchItems.trim()
    ? items.filter((i) => i.name.toLowerCase().includes(searchItems.toLowerCase()))
    : items;

  // === Inline create handlers ===
  const saveInlineItem = () => {
    const name = newItem.name.trim();
    if (!name) return;
    const id = uid("it");
    const created = {
      id, name,
      category: newItem.category || (categories[0]?.name || "Other"),
      weight: newItem.weight.trim() || "0 g",
      quantity: 1,
      packed: false,
      consumable: false,
      expiry: "",
      remindDays: null,
    };
    setItems([created, ...items]);
    setPickedItemIds((s) => [...s, id]);
    setNewItem({ name: "", weight: "", category: "" });
    setInlineMode(null);
  };

  const saveInlineKit = () => {
    const name = newKit.name.trim();
    if (!name) return;
    const id = uid("kit");
    const created = { id, name, category: newKit.category || "", itemIds: [] };
    setKits([created, ...kits]);
    setPickedKitIds((s) => [...s, id]);
    setNewKit({ name: "", category: "" });
    setInlineMode(null);
  };

  const saveInlineCat = () => {
    const name = newCat.name.trim();
    if (!name) return;
    const id = uid("cat");
    const created = { id, name, icon: "tag" };
    setCategories([created, ...categories]);
    setPickedCategoryIds((s) => [...s, id]);
    setNewCat({ name: "" });
    setInlineMode(null);
  };

  // === Submit: create the trip + linked packlist if anything was packed ===
  const submit = () => {
    if (!form.name.trim()) return;
    const tripName = form.name.trim();
    const dateRange = form.start && form.end
      ? `${fmt(form.start)} - ${fmt(form.end)}`
      : form.start ? fmt(form.start) : t("trips.datePending");

    // Create the linked packlist if anything was picked.
    // Categories are expanded to their current items (live snapshot at save time)
    // PLUS any individual items picked. Kits are referenced by ID directly.
    const hasAnyPacking = pickedCategoryIds.length || pickedKitIds.length || pickedItemIds.length;
    if (hasAnyPacking) {
      // Resolve category items to ids
      const catItemIds = new Set();
      pickedCategoryIds.forEach((cid) => {
        const cat = categories.find((c) => c.id === cid);
        if (!cat) return;
        items.forEach((it) => {
          if (it.category === cat.name) catItemIds.add(it.id);
        });
      });
      // Merge with explicitly-picked individual items
      pickedItemIds.forEach((iid) => catItemIds.add(iid));

      // Create or update packlist with the same name as the trip
      const existing = packlists.find((p) => p.name.toLowerCase() === tripName.toLowerCase());
      if (existing) {
        // Merge into existing packlist (avoid wiping prior contents)
        const mergedKitIds = Array.from(new Set([...existing.kitIds, ...pickedKitIds]));
        const mergedItemIds = Array.from(new Set([...existing.itemIds, ...catItemIds]));
        setPacklists(packlists.map((p) =>
          p.id === existing.id ? { ...p, kitIds: mergedKitIds, itemIds: mergedItemIds } : p
        ));
      } else {
        const newPl = {
          id: uid("pl"),
          name: tripName,
          notes: form.dest.trim() ? `Trip to ${form.dest.trim()}` : "",
          kitIds: pickedKitIds,
          itemIds: Array.from(catItemIds),
        };
        setPacklists([newPl, ...packlists]);
      }
    }

    // Save the trip
    onCreate({
      name: tripName,
      dest: form.dest.trim() || t("trips.destPending"),
      date: dateRange,
      type: form.type || t("trips.unspecified"),
    });
  };

  const saveNewType = () => {
    const name = newType.name.trim();
    if (!name) return;
    onAddType({ name, climate: newType.climate.trim() || "Variable", days: newType.days.trim() || "1-7" });
    setForm({ ...form, type: name });
    setNewType({ name: "", climate: "", days: "" });
    setAddingType(false);
  };

  const removeType = (tt) => {
    onDeleteType(tt.id);
    if (form.type === tt.name) setForm({ ...form, type: "" });
  };

  // ============== STEP 1 ==============
  if (step === 1) {
    return (
      <div style={{ maxWidth: 720 }}>
        <div style={{ marginBottom: 14, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
          {t("trips.step1")}  ·  {t("trips.stepDetailsTitle")}
        </div>
        <SectionHeader num="A" label={t("trips.itinerary")} right={t("trips.formCode")} />
        <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 22 : 28 }}>
          <Field label={t("trips.tripName")} icon={MapPin} value={form.name} onChange={set("name")} placeholder={t("trips.tripNamePh")} />
          <Field label={t("trips.destination")} icon={Globe} value={form.dest} onChange={set("dest")} placeholder={t("trips.destinationPh")} />
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: isMobile ? 18 : 24 }}>
            <Field label={t("trips.startDate")} type="date" icon={Calendar} value={form.start} onChange={set("start")} />
            <Field label={t("trips.endDate")} type="date" icon={Calendar} value={form.end} onChange={set("end")} />
          </div>

          {/* Trip type — custom dropdown (icon + name) */}
          <div>
            <div style={{ marginBottom: 10, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
              {t("trips.tripType")}
            </div>
            <TripTypeSelect value={form.type} onChange={(v) => setForm({ ...form, type: v })} />
          </div>
        </div>
        <div style={{ marginTop: isMobile ? 28 : 40, display: "flex", gap: 10, flexDirection: isMobile ? "column-reverse" : "row" }}>
          <Btn variant="ghost" icon={X} onClick={onCancel} fullWidth={isMobile}>{t("common.cancel")}</Btn>
          <Btn onClick={() => form.name.trim() && setStep(2)} variant="rust" icon={ChevronRight} fullWidth={isMobile} disabled={!form.name.trim()}>
            {t("trips.next")}
          </Btn>
        </div>
      </div>
    );
  }

  // ============== STEP 2 ==============
  const summaryText = (pickedCategoryIds.length || pickedKitIds.length || pickedItemIds.length)
    ? t("trips.summaryFmt", { c: pickedCategoryIds.length, k: pickedKitIds.length, i: pickedItemIds.length })
    : t("trips.summaryNothing");

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ marginBottom: 14, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
        {t("trips.step2")}  ·  {t("trips.stepPackTitle")}
      </div>
      <SectionHeader num="B" label={t("trips.stepPackTitle")} right={t("trips.formCode")} />
      <div style={{ marginBottom: 18, fontFamily: F.body, fontStyle: "italic", color: C.inkSoft, fontSize: 14 }}>
        {t("trips.stepPackSub")}
      </div>

      {/* Live summary */}
      <div style={{ padding: "10px 14px", background: C.ink, color: C.paper, marginBottom: 24, fontFamily: F.mono, fontSize: 11, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700 }}>
        {t("trips.summarySection")}: <span style={{ marginLeft: 6, opacity: 0.85 }}>{summaryText}</span>
      </div>

      {/* === CATEGORIES picker === */}
      <PackPickerSection
        title={t("trips.packCategoriesHeading")}
        hint={t("trips.packCategoriesHint")}
        count={`${pickedCategoryIds.length} / ${categories.length}`}
        emptyLabel={t("trips.packEmptyCats")}
        items={filteredCats}
        searchValue={searchCats}
        setSearchValue={setSearchCats}
        renderRow={(c) => {
          const sel = pickedCategoryIds.includes(c.id);
          const itemCount = items.filter((i) => i.category === c.name).length;
          const Icon = iconFor(c.icon);
          return (
            <button key={c.id} onClick={() => toggleCategory(c.id)} style={{
              display: "flex", alignItems: "center", gap: 10, padding: 10,
              border: `1.5px solid ${sel ? C.forest : C.line}`,
              background: sel ? C.paper : "transparent",
              cursor: "pointer", textAlign: "left", width: "100%",
            }}>
              <span style={{ width: 22, height: 22, flexShrink: 0, border: `1.5px solid ${sel ? C.forest : C.muted}`, background: sel ? C.forest : "transparent", color: C.paper, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                {sel && <Check size={13} strokeWidth={3} />}
              </span>
              <Icon size={16} strokeWidth={1.4} color={C.forest} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: F.body, fontSize: 14, fontWeight: 500 }}>{tOrLiteral(lang, "cat", c.name)}</div>
                <div style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                  {itemCount} {itemCount === 1 ? "item" : "items"}
                </div>
              </div>
            </button>
          );
        }}
        addNewLabel={t("trips.addNewCatInline")}
        addingNew={inlineMode === "cat"}
        onAddNewClick={() => setInlineMode(inlineMode === "cat" ? null : "cat")}
        inlineCreate={inlineMode === "cat" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Field label={t("trips.inlineCatName")} value={newCat.name} onChange={(e) => setNewCat({ name: e.target.value })} />
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <Btn variant="ghost" icon={X} onClick={() => { setInlineMode(null); setNewCat({ name: "" }); }}>{t("trips.inlineCancel")}</Btn>
              <Btn variant="rust" icon={Check} onClick={saveInlineCat} disabled={!newCat.name.trim()}>{t("trips.inlineSave")}</Btn>
            </div>
          </div>
        )}
      />

      {/* === KITS picker === */}
      <PackPickerSection
        title={t("trips.packKitsHeading")}
        hint={t("trips.packKitsHint")}
        count={`${pickedKitIds.length} / ${kits.length}`}
        emptyLabel={t("trips.packEmptyKits")}
        items={filteredKits}
        searchValue={searchKits}
        setSearchValue={setSearchKits}
        renderRow={(k) => {
          const sel = pickedKitIds.includes(k.id);
          const itemCount = (k.itemIds || []).length;
          return (
            <button key={k.id} onClick={() => toggleKit(k.id)} style={{
              display: "flex", alignItems: "center", gap: 10, padding: 10,
              border: `1.5px solid ${sel ? C.forest : C.line}`,
              background: sel ? C.paper : "transparent",
              cursor: "pointer", textAlign: "left", width: "100%",
            }}>
              <span style={{ width: 22, height: 22, flexShrink: 0, border: `1.5px solid ${sel ? C.forest : C.muted}`, background: sel ? C.forest : "transparent", color: C.paper, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                {sel && <Check size={13} strokeWidth={3} />}
              </span>
              <Backpack size={16} strokeWidth={1.4} color={C.forest} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: F.body, fontSize: 14, fontWeight: 500 }}>{k.name}</div>
                <div style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                  {itemCount} {itemCount === 1 ? "item" : "items"}{k.category ? `  ·  ${k.category}` : ""}
                </div>
              </div>
            </button>
          );
        }}
        addNewLabel={t("trips.addNewKitInline")}
        addingNew={inlineMode === "kit"}
        onAddNewClick={() => setInlineMode(inlineMode === "kit" ? null : "kit")}
        inlineCreate={inlineMode === "kit" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Field label={t("trips.inlineKitName")} value={newKit.name} onChange={(e) => setNewKit({ ...newKit, name: e.target.value })} />
            <CategorySelect categories={categories} value={newKit.category} onChange={(v) => setNewKit({ ...newKit, category: v })} />
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <Btn variant="ghost" icon={X} onClick={() => { setInlineMode(null); setNewKit({ name: "", category: "" }); }}>{t("trips.inlineCancel")}</Btn>
              <Btn variant="rust" icon={Check} onClick={saveInlineKit} disabled={!newKit.name.trim()}>{t("trips.inlineSave")}</Btn>
            </div>
          </div>
        )}
      />

      {/* === INDIVIDUAL ITEMS picker === */}
      <PackPickerSection
        title={t("trips.packItemsHeading")}
        hint={t("trips.packItemsHint")}
        count={`${pickedItemIds.length} / ${items.length}`}
        emptyLabel={t("trips.packEmptyItems")}
        items={filteredItems}
        searchValue={searchItems}
        setSearchValue={setSearchItems}
        renderRow={(it) => {
          const sel = pickedItemIds.includes(it.id);
          return (
            <button key={it.id} onClick={() => toggleItem(it.id)} style={{
              display: "flex", alignItems: "center", gap: 10, padding: 8,
              border: `1.5px solid ${sel ? C.forest : C.line}`,
              background: sel ? C.paper : "transparent",
              cursor: "pointer", textAlign: "left", width: "100%",
            }}>
              <span style={{ width: 20, height: 20, flexShrink: 0, border: `1.5px solid ${sel ? C.forest : C.muted}`, background: sel ? C.forest : "transparent", color: C.paper, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                {sel && <Check size={12} strokeWidth={3} />}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: F.body, fontSize: 13, fontWeight: 500 }}>{it.name}</div>
                <div style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em" }}>
                  {tOrLiteral(lang, "cat", it.category)}  ·  {it.weight}
                </div>
              </div>
            </button>
          );
        }}
        addNewLabel={t("trips.addNewItemInline")}
        addingNew={inlineMode === "item"}
        onAddNewClick={() => setInlineMode(inlineMode === "item" ? null : "item")}
        inlineCreate={inlineMode === "item" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Field label={t("trips.inlineItemName")} value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} />
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12 }}>
              <Field label={t("trips.inlineItemWeight")} value={newItem.weight} onChange={(e) => setNewItem({ ...newItem, weight: e.target.value })} placeholder="0.5 kg" />
              <CategorySelect categories={categories} value={newItem.category} onChange={(v) => setNewItem({ ...newItem, category: v })} />
            </div>
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <Btn variant="ghost" icon={X} onClick={() => { setInlineMode(null); setNewItem({ name: "", weight: "", category: "" }); }}>{t("trips.inlineCancel")}</Btn>
              <Btn variant="rust" icon={Check} onClick={saveInlineItem} disabled={!newItem.name.trim()}>{t("trips.inlineSave")}</Btn>
            </div>
          </div>
        )}
      />

      {/* Action row */}
      <div style={{ marginTop: isMobile ? 28 : 40, display: "flex", gap: 10, flexDirection: isMobile ? "column-reverse" : "row", justifyContent: "space-between", flexWrap: "wrap" }}>
        <Btn variant="ghost" icon={ArrowLeft} onClick={() => setStep(1)} fullWidth={isMobile}>{t("trips.back")}</Btn>
        <div style={{ display: "flex", gap: 10, flexDirection: isMobile ? "column-reverse" : "row" }}>
          <Btn variant="ghost" icon={Check} onClick={submit} fullWidth={isMobile}>{t("trips.skipPacking")}</Btn>
          <Btn onClick={submit} variant="rust" icon={Check} fullWidth={isMobile}>{t("trips.fileTrip")}</Btn>
        </div>
      </div>
    </div>
  );
}

/* Reusable picker section: search box + selectable rows + inline-create affordance.
   Used by inline-create flows for items/kits/categories within the wizard. */
function PackPickerSection({ title, hint, count, emptyLabel, items, searchValue, setSearchValue, renderRow, addNewLabel, addingNew, onAddNewClick, inlineCreate }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, paddingBottom: 6, borderBottom: `1px dashed ${C.line}` }}>
        <div>
          <span style={{ fontFamily: F.display, fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>{title}</span>
          <span style={{ marginLeft: 8, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>{count}</span>
        </div>
      </div>
      {hint && <div style={{ marginBottom: 10, fontFamily: F.body, fontSize: 12, color: C.muted, fontStyle: "italic" }}>{hint}</div>}

      {/* Search box */}
      {items.length > 0 && (
        <input
          type="text"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          placeholder="Search…"
          style={{
            width: "100%", padding: "8px 0", marginBottom: 10,
            background: "transparent", border: "none", borderBottom: `1px solid ${C.line}`,
            outline: "none", fontFamily: F.body, fontSize: 13, color: C.ink,
          }}
        />
      )}

      {/* Rows */}
      {items.length === 0 ? (
        <div style={{ padding: 14, background: C.paperDeep, border: `1px dashed ${C.line}`, fontFamily: F.body, fontSize: 13, color: C.inkSoft, fontStyle: "italic", textAlign: "center" }}>
          {emptyLabel}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 280, overflowY: "auto" }}>
          {items.map(renderRow)}
        </div>
      )}

      {/* Inline create */}
      <div style={{ marginTop: 10 }}>
        <button onClick={onAddNewClick}
          style={{ background: "transparent", border: `1px dashed ${C.line}`, padding: "8px 12px", cursor: "pointer", fontFamily: F.mono, fontSize: 11, letterSpacing: "0.15em", textTransform: "uppercase", color: C.forest, fontWeight: 700, width: "100%", textAlign: "center" }}>
          {addNewLabel}
        </button>
        {addingNew && (
          <div style={{ marginTop: 10, padding: 14, background: C.paperDeep, border: `1.5px dashed ${C.line}` }}>
            {inlineCreate}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   PacklistPickedSummary — compact summary of what's currently
   picked for this packlist. Three collapse-by-default sections:
   Items, Kits, Categories. Each row has an X to remove the
   pick from THIS packlist only (does not delete from inventory).
   ============================================================ */
function PacklistPickedSummary({
  categories,
  kits,
  items,
  pickedCategoryIds, setPickedCategoryIds,
  pickedKitIds, setPickedKitIds,
  pickedItemIds, setPickedItemIds,
}) {
  const { t } = useI18n();
  const { isMobile } = useViewport();
  // All collapsed by default — user opens what they want to review.
  const [openSection, setOpenSection] = useState(null); // "items" | "kits" | "cats" | null

  // Resolve picked ids to entities
  const pickedItems      = items.filter((i) => pickedItemIds.includes(i.id));
  const pickedKits       = kits.filter((k) => pickedKitIds.includes(k.id));
  const pickedCategories = categories.filter((c) => pickedCategoryIds.includes(c.id));

  // Removers — only remove from this packlist, NOT from inventory
  const removeItem = (id) => setPickedItemIds(pickedItemIds.filter((x) => x !== id));
  const removeKit  = (id) => setPickedKitIds(pickedKitIds.filter((x) => x !== id));
  const removeCat  = (id) => setPickedCategoryIds(pickedCategoryIds.filter((x) => x !== id));

  // A reusable section header — click to expand/collapse
  const SectionHeader = ({ keyId, label, count }) => {
    const open = openSection === keyId;
    return (
      <button
        onClick={() => setOpenSection(open ? null : keyId)}
        style={{
          width: "100%", padding: "12px 14px",
          background: open ? C.ink : C.paper,
          color: open ? C.paper : C.ink,
          border: `1.5px solid ${C.ink}`,
          cursor: "pointer", textAlign: "left",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
          fontFamily: F.mono, fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700,
        }}>
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18 }}>
            {open ? <ChevronDown size={14} strokeWidth={2.5} /> : <ChevronRight size={14} strokeWidth={2.5} />}
          </span>
          {label}
        </span>
        <span style={{ opacity: 0.7 }}>{count}</span>
      </button>
    );
  };

  // A row inside a section — shows the entity name + X-to-remove button
  const Row = ({ name, sub, onRemove }) => (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
      borderBottom: `1px solid ${C.line}`,
      background: C.paper,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: F.body, fontSize: 14, fontWeight: 500, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
        {sub && (
          <div style={{ marginTop: 2, fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>{sub}</div>
        )}
      </div>
      <button onClick={onRemove}
        style={{
          flexShrink: 0, width: 28, height: 28, padding: 0,
          background: "transparent", border: `1px solid ${C.muted}`,
          color: C.muted, cursor: "pointer",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.rust; e.currentTarget.style.color = C.rust; }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.muted; e.currentTarget.style.color = C.muted; }}
        aria-label={t("picked.removeFromPacklist")}
        title={t("picked.removeFromPacklist")}
      >
        <X size={14} strokeWidth={2.5} />
      </button>
    </div>
  );

  return (
    <div>
      <div style={{ marginBottom: 14, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
        {t("picked.heading")}
      </div>

      {/* === ITEMS === */}
      <div style={{ marginBottom: 10 }}>
        <SectionHeader keyId="items" label={t("picked.items")} count={pickedItems.length} />
        {openSection === "items" && (
          <div style={{ borderLeft: `1.5px solid ${C.ink}`, borderRight: `1.5px solid ${C.ink}`, borderBottom: `1.5px solid ${C.ink}` }}>
            {pickedItems.length === 0 ? (
              <div style={{ padding: "12px 14px", fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.inkSoft }}>
                {t("picked.emptyItems")}
              </div>
            ) : (
              pickedItems.map((it) => (
                <Row key={it.id}
                  name={it.name}
                  sub={`${it.category || t("trips.unifiedNoCategory")}${it.weight ? ` · ${it.weight}` : ""}`}
                  onRemove={() => removeItem(it.id)} />
              ))
            )}
          </div>
        )}
      </div>

      {/* === KITS === */}
      <div style={{ marginBottom: 10 }}>
        <SectionHeader keyId="kits" label={t("picked.kits")} count={pickedKits.length} />
        {openSection === "kits" && (
          <div style={{ borderLeft: `1.5px solid ${C.ink}`, borderRight: `1.5px solid ${C.ink}`, borderBottom: `1.5px solid ${C.ink}` }}>
            {pickedKits.length === 0 ? (
              <div style={{ padding: "12px 14px", fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.inkSoft }}>
                {t("picked.emptyKits")}
              </div>
            ) : (
              pickedKits.map((k) => {
                const itemCount = (k.itemIds || []).length;
                return (
                  <Row key={k.id}
                    name={k.name}
                    sub={`${k.category || t("trips.unifiedNoCategory")} · ${itemCount} ${itemCount === 1 ? "item" : "items"}`}
                    onRemove={() => removeKit(k.id)} />
                );
              })
            )}
          </div>
        )}
      </div>

      {/* === CATEGORIES === */}
      <div style={{ marginBottom: 10 }}>
        <SectionHeader keyId="cats" label={t("picked.categories")} count={pickedCategories.length} />
        {openSection === "cats" && (
          <div style={{ borderLeft: `1.5px solid ${C.ink}`, borderRight: `1.5px solid ${C.ink}`, borderBottom: `1.5px solid ${C.ink}` }}>
            {pickedCategories.length === 0 ? (
              <div style={{ padding: "12px 14px", fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.inkSoft }}>
                {t("picked.emptyCats")}
              </div>
            ) : (
              pickedCategories.map((c) => {
                const itemsInCat = items.filter((i) => i.category === c.name).length;
                return (
                  <Row key={c.id}
                    name={c.name}
                    sub={`${itemsInCat} ${itemsInCat === 1 ? "item" : "items"}`}
                    onRemove={() => removeCat(c.id)} />
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   UnifiedInventoryBrowser — single picker showing the entire
   inventory organized by category. Each category section has:
     • An "Add this whole category" tickable row at the top
     • Tickable rows for kits in that category (expandable to
       show individual items)
     • Tickable rows for items in that category not in any kit
   Search filters within sections, keeping the structure visible.
   "Uncategorized" section catches items/kits without a category.
   ============================================================ */
function UnifiedInventoryBrowser({
  categories,
  kits,
  items,
  pickedCategoryIds, setPickedCategoryIds,
  pickedKitIds, setPickedKitIds,
  pickedItemIds, setPickedItemIds,
}) {
  const { t, lang, units } = useI18n();
  const { isMobile } = useViewport();
  const [search, setSearch] = useState("");
  const [expandedKits, setExpandedKits] = useState(new Set());
  const [collapsedCategories, setCollapsedCategories] = useState(new Set());
  const [expandedItems, setExpandedItems] = useState(new Set());  // item ids whose detail panels are open

  // Toggling helpers
  const toggleCategory = (id) =>
    setPickedCategoryIds(pickedCategoryIds.includes(id) ? pickedCategoryIds.filter((x) => x !== id) : [...pickedCategoryIds, id]);
  const toggleKit = (id) =>
    setPickedKitIds(pickedKitIds.includes(id) ? pickedKitIds.filter((x) => x !== id) : [...pickedKitIds, id]);
  const toggleItem = (id) =>
    setPickedItemIds(pickedItemIds.includes(id) ? pickedItemIds.filter((x) => x !== id) : [...pickedItemIds, id]);
  const toggleExpand = (kitId) => {
    const next = new Set(expandedKits);
    if (next.has(kitId)) next.delete(kitId); else next.add(kitId);
    setExpandedKits(next);
  };
  const toggleExpandItem = (itemId) => {
    const next = new Set(expandedItems);
    if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
    setExpandedItems(next);
  };
  // Cascade expand/collapse: when a category opens, all kits inside auto-expand.
  // When it collapses, those kits + any item details auto-collapse.
  const toggleCategoryCollapse = (catName, kitsInCat) => {
    const isCurrentlyCollapsed = collapsedCategories.has(catName);
    const nextCollapsed = new Set(collapsedCategories);
    const nextExpandedKits = new Set(expandedKits);
    const nextExpandedItems = new Set(expandedItems);

    if (isCurrentlyCollapsed) {
      // Opening — also auto-expand every kit inside
      nextCollapsed.delete(catName);
      kitsInCat.forEach((k) => nextExpandedKits.add(k.id));
    } else {
      // Closing — also collapse every kit inside, and close any open item details
      // for items inside those kits
      nextCollapsed.add(catName);
      kitsInCat.forEach((k) => {
        nextExpandedKits.delete(k.id);
        (k.itemIds || []).forEach((iid) => nextExpandedItems.delete(iid));
      });
    }
    setCollapsedCategories(nextCollapsed);
    setExpandedKits(nextExpandedKits);
    setExpandedItems(nextExpandedItems);
  };

  // Build the grouped data structure
  // For each category: list of kits in that category + list of "loose" items in that category
  // (items that aren't part of any kit). Plus an "Uncategorized" bucket for kits/items
  // with no category.
  const searchLower = search.trim().toLowerCase();
  const matchesSearch = (text) => !searchLower || (text || "").toLowerCase().includes(searchLower);

  // Build a set of all itemIds that belong to ANY kit, so we can determine which
  // items are "loose" (not covered by any kit row).
  const itemsInAnyKit = new Set();
  kits.forEach((k) => (k.itemIds || []).forEach((iid) => itemsInAnyKit.add(iid)));

  // Group everything
  const sections = [];
  const usedItemIds = new Set();
  const usedKitIds = new Set();

  categories.forEach((cat) => {
    const kitsInCat = kits.filter((k) => k.category === cat.name);
    const itemsInCat = items.filter((it) => it.category === cat.name);
    const looseItems = itemsInCat.filter((it) => !itemsInAnyKit.has(it.id));

    // Apply search filter
    const visibleKits = kitsInCat.filter((k) => {
      if (matchesSearch(k.name)) return true;
      // Also visible if any of its items match
      return (k.itemIds || []).some((iid) => {
        const it = items.find((x) => x.id === iid);
        return it && matchesSearch(it.name);
      });
    });
    const visibleLooseItems = looseItems.filter((it) => matchesSearch(it.name));
    const matchesCategoryName = matchesSearch(cat.name);

    // Skip empty sections when searching
    if (searchLower && !matchesCategoryName && visibleKits.length === 0 && visibleLooseItems.length === 0) return;

    visibleKits.forEach((k) => usedKitIds.add(k.id));
    visibleLooseItems.forEach((it) => usedItemIds.add(it.id));

    sections.push({
      category: cat,
      kits: visibleKits,
      looseItems: visibleLooseItems,
    });
  });

  // Uncategorized bucket — kits + items with no matching category
  const uncatKits = kits.filter((k) => !usedKitIds.has(k.id) && (!k.category || !categories.find((c) => c.name === k.category)));
  const uncatItems = items.filter((it) => !usedItemIds.has(it.id) && !categories.find((c) => c.name === it.category) && !itemsInAnyKit.has(it.id));
  const visibleUncatKits = uncatKits.filter((k) => matchesSearch(k.name));
  const visibleUncatItems = uncatItems.filter((it) => matchesSearch(it.name));
  if (visibleUncatKits.length || visibleUncatItems.length) {
    sections.push({
      category: { id: "_uncat", name: t("trips.unifiedNoCategory"), icon: "tag" },
      kits: visibleUncatKits,
      looseItems: visibleUncatItems,
      isUncategorized: true,
    });
  }

  const totalSelected = pickedCategoryIds.length + pickedKitIds.length + pickedItemIds.length;
  const isInventoryEmpty = items.length === 0 && kits.length === 0 && categories.length === 0;

  // Render an item row with split interaction:
  //   • Left checkbox toggles "include this item in the trip"
  //   • Right body toggles "show item details inline"
  // Detail panel below shows all fields read-only.
  // `compact` flag = smaller variant for items inside an expanded kit.
  const renderItemRow = (it, compact = false) => {
    const sel = pickedItemIds.includes(it.id);
    const isExpanded = expandedItems.has(it.id);
    const cat = categories.find((c) => c.name === it.category);
    const Icon = iconFor(cat?.icon || "tag");
    const expiryAlert = it.expiry ? daysUntil(it.expiry) : null;
    const expiringSoon = expiryAlert !== null && expiryAlert <= (it.remindDays || 30) && expiryAlert >= 0;
    const expired = expiryAlert !== null && expiryAlert < 0;

    return (
      <div key={it.id} style={{
        border: `1.5px solid ${sel ? C.forest : C.line}`,
        background: sel ? C.paperDeep : C.paper,
      }}>
        <div style={{ display: "flex", alignItems: "stretch" }}>
          {/* LEFT: tick checkbox */}
          <button
            onClick={() => toggleItem(it.id)}
            aria-label={sel ? "Remove from trip" : "Add to trip"}
            style={{
              padding: compact ? "0 10px" : "0 12px",
              background: "transparent", border: "none",
              borderRight: `1px dashed ${C.line}`,
              cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <span style={{
              width: compact ? 18 : 20, height: compact ? 18 : 20, flexShrink: 0,
              border: `1.5px solid ${sel ? C.forest : C.muted}`,
              background: sel ? C.forest : "transparent",
              color: C.paper,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
            }}>
              {sel && <Check size={compact ? 11 : 12} strokeWidth={3} />}
            </span>
          </button>

          {/* RIGHT: name + tap to expand details */}
          <button
            onClick={() => toggleExpandItem(it.id)}
            style={{
              flex: 1, minWidth: 0,
              padding: compact ? "8px 10px" : "10px 12px",
              background: "transparent", border: "none", cursor: "pointer", textAlign: "left",
              display: "flex", alignItems: "center", gap: 8,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontFamily: F.body, fontSize: compact ? 12 : 13, fontWeight: 500,
                display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
              }}>
                <span>{it.name}</span>
                {it.quantity > 1 && (
                  <span style={{ padding: "1px 5px", background: C.ink, color: C.paper, fontFamily: F.mono, fontSize: 8, letterSpacing: "0.12em", fontWeight: 700 }}>
                    ×{it.quantity}
                  </span>
                )}
                {it.packed && (
                  <span style={{ padding: "1px 5px", background: C.forest, color: C.paper, fontFamily: F.mono, fontSize: 8, letterSpacing: "0.12em", fontWeight: 700 }}>
                    PACKED
                  </span>
                )}
                {expired && (
                  <span style={{ padding: "1px 5px", background: C.rust, color: C.paper, fontFamily: F.mono, fontSize: 8, letterSpacing: "0.12em", fontWeight: 700 }}>
                    EXPIRED
                  </span>
                )}
                {!expired && expiringSoon && (
                  <span style={{ padding: "1px 5px", background: C.ochre, color: C.ink, fontFamily: F.mono, fontSize: 8, letterSpacing: "0.12em", fontWeight: 700 }}>
                    {expiryAlert}d
                  </span>
                )}
              </div>
              <div style={{ fontFamily: F.mono, fontSize: compact ? 9 : 10, color: C.muted, letterSpacing: "0.1em", marginTop: 2 }}>
                {formatWeight(it.weight, units)} {it.category ? `· ${tOrLiteral(lang, "cat", it.category)}` : ""}
              </div>
            </div>
            <span style={{
              color: isExpanded ? C.forest : C.muted,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 28, height: 28,
              border: `1.5px solid ${isExpanded ? C.forest : C.line}`,
              background: isExpanded ? C.paperDeep : "transparent",
              flexShrink: 0,
            }}>
              <Menu size={14} strokeWidth={2} />
            </span>
          </button>
        </div>

        {/* Detail panel — shown when this item is expanded */}
        {isExpanded && (
          <div style={{
            padding: 12, background: C.paperDeep, borderTop: `1px dashed ${C.line}`,
            display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 10,
            fontFamily: F.body, fontSize: 12,
          }}>
            <DetailKV k="Category" v={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Icon size={12} strokeWidth={1.6} color={C.forest} />
                {it.category ? tOrLiteral(lang, "cat", it.category) : "—"}
              </span>
            } />
            <DetailKV k="Weight" v={formatWeight(it.weight, units) || "—"} />
            <DetailKV k="Quantity" v={it.quantity > 0 ? it.quantity : 1} />
            <DetailKV k="Packed" v={it.packed ? "Yes" : "No"} />
            <DetailKV k="Consumable" v={it.consumable ? "Yes" : "No"} />
            <DetailKV k="Expiry" v={
              it.expiry
                ? `${it.expiry}${expired ? " (expired)" : expiringSoon ? ` (${expiryAlert}d left)` : ""}`
                : "—"
            } />
            {it.remindDays != null && it.remindDays !== "" && (
              <DetailKV k="Reminder" v={`${it.remindDays} days before expiry`} />
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <div>
            <span style={{ fontFamily: F.display, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
              {t("trips.unifiedTitle")}
            </span>
            <span style={{ marginLeft: 10, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>
              {totalSelected} picked
            </span>
          </div>
        </div>
        <div style={{ marginTop: 4, fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.muted }}>
          {t("trips.unifiedSub")}
        </div>
      </div>

      {/* Search */}
      {!isInventoryEmpty && (
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("trips.unifiedSearchPh")}
          style={{
            width: "100%",
            padding: "10px 0",
            marginBottom: 16,
            background: "transparent",
            border: "none",
            borderBottom: `1.5px solid ${C.ink}`,
            outline: "none",
            fontFamily: F.body,
            fontSize: 15,
            color: C.ink,
          }}
        />
      )}

      {/* Empty state */}
      {isInventoryEmpty && (
        <div style={{ padding: 24, background: C.paperDeep, border: `1px dashed ${C.line}`, fontFamily: F.body, fontSize: 14, color: C.inkSoft, fontStyle: "italic", textAlign: "center" }}>
          {t("trips.unifiedEmptyInventory")}
        </div>
      )}

      {/* Sections */}
      {!isInventoryEmpty && sections.length === 0 && (
        <div style={{ padding: 16, background: C.paperDeep, border: `1px dashed ${C.line}`, fontFamily: F.body, fontSize: 13, color: C.muted, fontStyle: "italic", textAlign: "center" }}>
          No matches. Try a different search.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {sections.map((section) => {
          const cat = section.category;
          const Icon = iconFor(cat.icon || "tag");
          const collapsed = collapsedCategories.has(cat.name);
          const catSelected = !section.isUncategorized && pickedCategoryIds.includes(cat.id);
          const totalInCategory = section.kits.length + section.looseItems.length;

          return (
            <div key={cat.id} style={{ border: `1.5px solid ${catSelected ? C.forest : C.line}`, background: catSelected ? C.paperDeep : C.paper }}>
              {/* Category header: checkbox (whole-category live-link) + body (collapse/expand) */}
              <div style={{ display: "flex", alignItems: "stretch", borderBottom: collapsed ? "none" : `1px solid ${C.line}`, background: C.paperDeep }}>
                {/* Checkbox toggle — only for real categories, not "Uncategorized" */}
                {!section.isUncategorized && (
                  <button
                    onClick={() => toggleCategory(cat.id)}
                    aria-label={t("trips.unifiedAllInCategory")}
                    title={t("trips.unifiedAllInCategoryHint")}
                    style={{
                      padding: "0 14px", background: "transparent", border: "none", borderRight: `1px dashed ${C.line}`,
                      cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <span style={{
                      width: 22, height: 22, flexShrink: 0,
                      border: `1.5px solid ${catSelected ? C.forest : C.muted}`,
                      background: catSelected ? C.forest : "transparent",
                      color: C.paper,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                    }}>
                      {catSelected && <Check size={13} strokeWidth={3} />}
                    </span>
                  </button>
                )}

                {/* Category body — clickable to expand/collapse */}
                <button
                  onClick={() => toggleCategoryCollapse(cat.name, section.kits)}
                  style={{
                    flex: 1, minWidth: 0,
                    padding: "12px 14px", background: "transparent", border: "none",
                    cursor: "pointer", textAlign: "left",
                    display: "flex", alignItems: "center", gap: 10,
                  }}
                >
                  <Icon size={18} strokeWidth={1.4} color={C.forest} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: F.display, fontSize: 16, fontWeight: 700, letterSpacing: "-0.01em" }}>
                      {tOrLiteral(lang, "cat", cat.name)}
                      {catSelected && (
                        <span style={{ marginLeft: 8, padding: "1px 6px", background: C.forest, color: C.paper, fontFamily: F.mono, fontSize: 8, letterSpacing: "0.15em", fontWeight: 700, verticalAlign: "middle" }}>
                          ALL · LIVE
                        </span>
                      )}
                    </div>
                    <div style={{ fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>
                      {section.kits.length} kits · {section.looseItems.length} items
                    </div>
                  </div>
                  <span style={{
                    color: collapsed ? C.muted : C.forest,
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 32, height: 32,
                    border: `1.5px solid ${collapsed ? C.line : C.forest}`,
                    background: collapsed ? "transparent" : C.paperDeep,
                    flexShrink: 0,
                  }}>
                    <Menu size={16} strokeWidth={2} />
                  </span>
                </button>
              </div>

              {!collapsed && (
                <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                  {/* Kits */}
                  {section.kits.map((k) => {
                    const kitSelected = pickedKitIds.includes(k.id);
                    const isExpanded = expandedKits.has(k.id);
                    const kitItems = (k.itemIds || []).map((id) => items.find((i) => i.id === id)).filter(Boolean);
                    return (
                      <div key={k.id} style={{ border: `1.5px solid ${kitSelected ? C.forest : C.line}`, background: kitSelected ? C.paperDeep : C.paper }}>
                        <div style={{ display: "flex", alignItems: "stretch" }}>
                          <button
                            onClick={() => toggleKit(k.id)}
                            style={{
                              flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10, padding: 10,
                              background: "transparent", border: "none", cursor: "pointer", textAlign: "left",
                            }}
                          >
                            <span style={{
                              width: 22, height: 22, flexShrink: 0,
                              border: `1.5px solid ${kitSelected ? C.forest : C.muted}`,
                              background: kitSelected ? C.forest : "transparent",
                              color: C.paper,
                              display: "inline-flex", alignItems: "center", justifyContent: "center",
                            }}>
                              {kitSelected && <Check size={13} strokeWidth={3} />}
                            </span>
                            <Backpack size={16} strokeWidth={1.4} color={C.forest} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontFamily: F.body, fontSize: 14, fontWeight: 600 }}>
                                {k.name}
                                <span style={{ marginLeft: 8, padding: "1px 5px", background: C.forest, color: C.paper, fontFamily: F.mono, fontSize: 8, letterSpacing: "0.15em", fontWeight: 700, verticalAlign: "middle" }}>
                                  {t("trips.kitChip")}
                                </span>
                              </div>
                              <div style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                                {kitItems.length} {kitItems.length === 1 ? "item" : "items"}
                              </div>
                            </div>
                          </button>
                          {kitItems.length > 0 && (
                            <button
                              onClick={() => toggleExpand(k.id)}
                              style={{
                                width: 48, background: "transparent", border: "none", borderLeft: `1px dashed ${C.line}`,
                                cursor: "pointer",
                                color: isExpanded ? C.forest : C.muted,
                                display: "flex", alignItems: "center", justifyContent: "center",
                              }}
                              title={isExpanded ? t("trips.unifiedCollapse") : t("trips.unifiedExpand")}
                              aria-label={isExpanded ? t("trips.unifiedCollapse") : t("trips.unifiedExpand")}
                            >
                              <span style={{
                                display: "inline-flex", alignItems: "center", justifyContent: "center",
                                width: 32, height: 32,
                                border: `1.5px solid ${isExpanded ? C.forest : C.line}`,
                                background: isExpanded ? C.paperDeep : "transparent",
                              }}>
                                <Menu size={15} strokeWidth={2} />
                              </span>
                            </button>
                          )}
                        </div>

                        {/* Expanded item list */}
                        {isExpanded && kitItems.length > 0 && (
                          <div style={{ padding: "8px 10px 10px 38px", background: C.paperDeep, borderTop: `1px dashed ${C.line}`, display: "flex", flexDirection: "column", gap: 6 }}>
                            <div style={{ fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 4 }}>
                              {t("trips.unifiedKitItemsHeading")}
                            </div>
                            {kitItems.map((it) => renderItemRow(it, true))}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Loose items in this category (not in any kit) */}
                  {section.looseItems.map((it) => renderItemRow(it, false))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// Simple read-only key/value pair used in item-detail panels
function DetailKV({ k, v }) {
  return (
    <div>
      <div style={{ fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 2 }}>
        {k}
      </div>
      <div style={{ fontFamily: F.body, fontSize: 13, color: C.ink }}>{v}</div>
    </div>
  );
}

// Simple category dropdown for the inline-create forms
function CategorySelect({ categories, value, onChange }) {
  const { t } = useI18n();
  return (
    <label style={{ display: "block" }}>
      <div style={{ marginBottom: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
        {t("trips.inlineItemCategory")}
      </div>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%", padding: "8px 28px 8px 0", background: "transparent", border: "none",
          borderBottom: `1.5px solid ${C.ink}`, outline: "none", fontFamily: F.body, fontSize: 14, color: C.ink,
          appearance: "none", WebkitAppearance: "none", cursor: "pointer",
          backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%231A2421' stroke-width='1.5' fill='none'/></svg>")`,
          backgroundRepeat: "no-repeat", backgroundPosition: "right 4px center",
        }}>
        <option value="">—</option>
        {categories.map((c) => (<option key={c.id} value={c.name}>{c.name}</option>))}
      </select>
    </label>
  );
}

function Trips({ go, trips, setTrips, travelTypes, setTravelTypes, shareService, currentUser, items, setItems, kits, setKits, categories, setCategories, packlists, setPacklists }) {
  const { t } = useI18n();
  const { isMobile } = useViewport();
  const [tab, setTab] = useState("saved");
  const [sharing, setSharing] = useState(null);
  const [publishing, setPublishing] = useState(null);
  const addTrip = (data) => { setTrips([{ id: uid("tr"), ...data }, ...trips]); setTab("saved"); };
  const deleteTrip = (id) => setTrips(trips.filter((tr) => tr.id !== id));
  const addType = (data) => setTravelTypes([{ id: uid("tt"), icon: "mountain", ...data }, ...travelTypes]);
  const deleteType = (id) => setTravelTypes(travelTypes.filter((tt) => tt.id !== id));
  return (
    <div>
      <Header go={go} active="trips" />
      <div style={{ padding: padX(isMobile) }}>
        <div style={{ marginTop: isMobile ? 24 : 40 }}>
          <Coord>{t("trips.section")}</Coord>
          <h1 style={{ margin: "12px 0", fontFamily: F.display, fontSize: "clamp(36px, 6vw, 72px)", fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 0.95 }}>
            {t("trips.titleA")} <span style={{ fontStyle: "italic", color: C.forest }}>{t("trips.titleB")}</span><span style={{ color: C.rust }}>?</span>
          </h1>
        </div>
        <div style={{ marginTop: isMobile ? 24 : 40, display: "flex", flexDirection: isMobile ? "column" : "row", justifyContent: "space-between", alignItems: isMobile ? "stretch" : "flex-end", gap: isMobile ? 14 : 16 }}>
          <div style={{ display: "flex", borderBottom: `1.5px solid ${C.ink}`, overflowX: "auto", WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}>
            {[["saved", t("trips.tabSaved", { n: trips.length })], ["create", t("trips.tabCreate")]].map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)}
                style={{ padding: isMobile ? "10px 14px" : "12px 20px", border: "none", cursor: "pointer", fontFamily: F.mono, fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", background: tab === k ? C.ink : "transparent", color: tab === k ? C.paper : C.ink, fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 }}>
                {l}
              </button>
            ))}
          </div>
          {tab === "saved" && <Btn variant="rust" icon={Plus} onClick={() => setTab("create")} fullWidth={isMobile}>{t("dash.planTrip")}</Btn>}
        </div>
        <div style={{ marginTop: isMobile ? 20 : 32 }}>
          {tab === "saved" && <SavedTrips trips={trips} onDelete={deleteTrip} onPlan={() => setTab("create")}
            onShare={shareService ? (tr) => setSharing({ kind: "trip", entity: tr }) : null}
            onPublish={currentUser?.id ? (tr) => setPublishing({ kind: "trip", entity: tr }) : null} />}
          {tab === "create" && <CreateTrip
            travelTypes={travelTypes}
            onAddType={addType}
            onDeleteType={deleteType}
            onCreate={addTrip}
            onCancel={() => setTab("saved")}
            items={items} setItems={setItems}
            kits={kits} setKits={setKits}
            categories={categories} setCategories={setCategories}
            packlists={packlists} setPacklists={setPacklists}
          />}
        </div>
      </div>
      <Footer />
      {sharing && shareService && (
        <ShareDialog
          kind={sharing.kind}
          entity={sharing.entity}
          shareService={shareService}
          currentUser={currentUser}
          items={items}
          kits={kits}
          categories={categories}
          packlists={packlists}
          onClose={() => setSharing(null)}
        />
      )}
      {publishing && currentUser?.id && (
        <PublishDialog
          kind={publishing.kind}
          entity={publishing.entity}
          currentUser={currentUser}
          items={items}
          kits={kits}
          categories={categories}
          packlists={packlists}
          onClose={() => setPublishing(null)}
        />
      )}
    </div>
  );
}

function AddCartForm({ onAdd, onCancel }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [qty, setQty] = useState(1);
  const save = () => {
    if (!name.trim()) return;
    onAdd({ name: name.trim(), qty: Math.max(1, qty) });
  };
  return (
    <AddPanel title={t("cart.formTitle")} onSave={save} onCancel={onCancel} saveLabel={t("cart.add")}>
      <Field label={t("cart.formItemName")} icon={ShoppingCart} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("cart.formItemNamePh")} />
      <div style={{ marginTop: 24 }}>
        <div style={{ marginBottom: 12, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>{t("form.qty")}</div>
        <div style={{ display: "inline-flex", border: `1.5px solid ${C.ink}` }}>
          <button onClick={() => setQty(Math.max(1, qty - 1))} disabled={qty <= 1} style={{ width: 40, height: 40, border: "none", background: "transparent", cursor: qty <= 1 ? "not-allowed" : "pointer", opacity: qty <= 1 ? 0.3 : 1, fontFamily: F.mono, fontSize: 18, fontWeight: 700 }}>-</button>
          <div style={{ width: 56, textAlign: "center", padding: "9px 0", borderLeft: `1px solid ${C.ink}`, borderRight: `1px solid ${C.ink}`, fontFamily: F.mono, fontSize: 16, fontWeight: 700 }}>{qty}</div>
          <button onClick={() => setQty(qty + 1)} style={{ width: 40, height: 40, border: "none", background: "transparent", cursor: "pointer", fontFamily: F.mono, fontSize: 18, fontWeight: 700 }}>+</button>
        </div>
      </div>
    </AddPanel>
  );
}

// Reusable cart panel — used by the standalone Cart screen AND
// the Cart tab on the Inventory roster page. Renders the add form,
// item list (mobile cards / desktop rows), and a simple item-count summary.
function CartPanel({ cart, setCart, adding, setAdding, hideHeader = false }) {
  const { t } = useI18n();
  const { isMobile } = useViewport();

  const totalQty = cart.reduce((s, i) => s + i.qty, 0);

  const addCart = (data) => { setCart([{ id: uid("c"), ...data }, ...cart]); setAdding(false); };
  const deleteCart = (id) => setCart(cart.filter((c) => c.id !== id));
  const updateQty = (id, delta) => setCart(cart.map((c) => (c.id === id ? { ...c, qty: Math.max(1, c.qty + delta) } : c)));

  // Simple "what's on the list" summary — replaces the priced bill of lading
  const summary = cart.length > 0 && (
    <div style={{ padding: isMobile ? 18 : 22, background: C.ink, color: C.paper, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
      <div>
        <div style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", opacity: 0.7 }}>{t("cart.bill")}</div>
        <div style={{ marginTop: 4, fontFamily: F.display, fontSize: isMobile ? 22 : 26, fontWeight: 700, letterSpacing: "-0.02em" }}>
          {cart.length} {cart.length === 1 ? "line" : "lines"} · {totalQty} {totalQty === 1 ? "unit" : "units"}
        </div>
      </div>
    </div>
  );

  // Mobile cart item: stacked card; Desktop: tabular row — both without price
  const cartItems = (
    cart.length === 0 ? (
      <EmptyState label={t("cart.empty")} hint={t("cart.emptyHint")} />
    ) : isMobile ? (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {cart.map((c, idx) => (
          <div key={c.id} style={{ background: C.paper, border: `1.5px solid ${C.ink}`, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Coord>SKU PMD-{1000 + idx}</Coord>
                <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 17, fontWeight: 600, lineHeight: 1.2, wordBreak: "break-word" }}>{c.name}</div>
              </div>
              <button onClick={() => deleteCart(c.id)} style={{ width: 38, height: 38, background: "transparent", border: `1px solid ${C.rust}`, color: C.rust, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }} aria-label="Remove">
                <Trash2 size={14} />
              </button>
            </div>
            <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-start", alignItems: "center", gap: 12 }}>
              <div style={{ display: "inline-flex", border: `1.5px solid ${C.ink}` }}>
                <button onClick={() => updateQty(c.id, -1)} disabled={c.qty <= 1} style={{ width: 38, height: 38, border: "none", cursor: c.qty <= 1 ? "not-allowed" : "pointer", background: "transparent", opacity: c.qty <= 1 ? 0.3 : 1, fontFamily: F.mono, fontSize: 18, fontWeight: 700 }}>-</button>
                <div style={{ minWidth: 40, textAlign: "center", padding: "9px 0", borderLeft: `1px solid ${C.ink}`, borderRight: `1px solid ${C.ink}`, fontFamily: F.mono, fontSize: 15, fontWeight: 700 }}>{c.qty}</div>
                <button onClick={() => updateQty(c.id, 1)} style={{ width: 38, height: 38, border: "none", cursor: "pointer", background: "transparent", fontFamily: F.mono, fontSize: 18, fontWeight: 700 }}>+</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    ) : (
      <>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 160px 50px", padding: "12px 24px", background: C.ink, color: C.paper, fontFamily: F.mono, fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase" }}>
          <div>{t("cart.colItem")}</div><div style={{ textAlign: "center" }}>{t("cart.colQty")}</div><div></div>
        </div>
        {cart.map((c, idx) => (
          <div key={c.id} style={{ display: "grid", gridTemplateColumns: "2fr 160px 50px", padding: "20px 24px", alignItems: "center", background: C.paper, borderBottom: `1px dashed ${C.line}` }}>
            <div>
              <Coord>SKU PMD-{1000 + idx}</Coord>
              <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 19, fontWeight: 600 }}>{c.name}</div>
            </div>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <div style={{ display: "inline-flex", border: `1.5px solid ${C.ink}` }}>
                <button onClick={() => updateQty(c.id, -1)} disabled={c.qty <= 1} style={{ width: 32, height: 32, border: "none", cursor: c.qty <= 1 ? "not-allowed" : "pointer", background: "transparent", opacity: c.qty <= 1 ? 0.3 : 1, fontFamily: F.mono, fontSize: 16, fontWeight: 700 }}>-</button>
                <div style={{ width: 36, textAlign: "center", padding: "6px 0", borderLeft: `1px solid ${C.ink}`, borderRight: `1px solid ${C.ink}`, fontFamily: F.mono, fontSize: 14, fontWeight: 700 }}>{c.qty}</div>
                <button onClick={() => updateQty(c.id, 1)} style={{ width: 32, height: 32, border: "none", cursor: "pointer", background: "transparent", fontFamily: F.mono, fontSize: 16, fontWeight: 700 }}>+</button>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <button onClick={() => deleteCart(c.id)} style={{ background: "none", border: "none", cursor: "pointer", color: C.rust, padding: 4 }} aria-label="Remove">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </>
    )
  );

  // Single-column layout — no more priced sidebar
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {adding && <AddCartForm onAdd={addCart} onCancel={() => setAdding(false)} />}
      {cartItems}
      {summary}
    </div>
  );
}

function Cart({ go, cart, setCart }) {
  const { t } = useI18n();
  const { isMobile } = useViewport();
  const [adding, setAdding] = useState(false);

  return (
    <div>
      <Header go={go} active="cart" />
      <div style={{ padding: padX(isMobile) }}>
        <div style={{ marginTop: isMobile ? 24 : 40 }}>
          <Coord>{t("cart.section")}</Coord>
          <h1 style={{ margin: "12px 0", fontFamily: F.display, fontSize: "clamp(36px, 6vw, 72px)", fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 0.95 }}>
            {t("cart.titleA")} <span style={{ fontStyle: "italic", color: C.forest }}>{t("cart.titleB")}</span><span style={{ color: C.rust }}>.</span>
          </h1>
        </div>
        <div style={{ marginTop: 24, display: "flex", justifyContent: isMobile ? "stretch" : "flex-end" }}>
          <Btn variant={adding ? "ghost" : "rust"} icon={adding ? X : Plus} onClick={() => setAdding(!adding)} fullWidth={isMobile}>{adding ? t("common.cancel") : t("cart.add")}</Btn>
        </div>
        <div style={{ marginTop: 24 }}>
          <CartPanel cart={cart} setCart={setCart} adding={adding} setAdding={setAdding} />
        </div>
      </div>
      <Footer />
    </div>
  );
}

function SettingGroup({ title, num, children }) {
  return (
    <div>
      <div style={{ marginBottom: 24, paddingBottom: 12, borderBottom: `1.5px solid ${C.ink}`, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontFamily: F.display, fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em" }}>{title}</div>
        <div style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: "0.2em", color: C.muted }}>{num}</div>
      </div>
      <div>{children}</div>
    </div>
  );
}

function SettingRow({ label, value }) {
  const { isMobile } = useViewport();
  // On mobile, complex values (toggles, language switch) often overflow; stack vertically.
  const isComplex = typeof value !== "string" && typeof value !== "number";
  const stack = isMobile && isComplex;
  return (
    <div style={{ display: "flex", flexDirection: stack ? "column" : "row", justifyContent: "space-between", alignItems: stack ? "flex-start" : "center", gap: stack ? 10 : 12, padding: "16px 0", borderBottom: `1px dashed ${C.line}` }}>
      <div style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: C.muted }}>{label}</div>
      <div style={{ fontFamily: F.body, fontSize: 16, textAlign: stack ? "left" : "right", maxWidth: "100%" }}>{value}</div>
    </div>
  );
}

/* ============================================================
   PACKLISTS — top-level entity. A packlist combines kits + items
   for a specific trip or purpose. Users can compose, edit, delete.
   ============================================================ */
function Packlists({ go, packlists, setPacklists, kits, setKits, items, setItems, categories, setCategories, travelTypes, setTravelTypes }) {
  const { t } = useI18n();
  const { isMobile } = useViewport();
  const [tab, setTab] = useState("saved");           // "saved" | "create" | "edit"
  const [editingId, setEditingId] = useState(null);  // when tab === "edit"
  const [openId, setOpenId] = useState(null);        // detail view
  const [editorOpenId, setEditorOpenId] = useState(null);  // modal editor — independent of tab/detail
  // Two layers of modals reachable from PacklistDetail:
  //   1) "Detail" modals — opened by tapping a card; show contents + add/remove
  //   2) "Form" modals — opened from inside a Detail modal (Edit) for full edit
  const [detailKitId, setDetailKitId] = useState(null);
  const [detailCategoryId, setDetailCategoryId] = useState(null);
  const [detailItemId, setDetailItemId] = useState(null);
  // Form modal — only used for items currently (kits/cats edit inline in their detail)
  const [formItemId, setFormItemId] = useState(null);

  const addPacklist = (data) => {
    setPacklists([{ id: uid("pl"), ...data }, ...packlists]);
    setTab("saved");
  };
  const updatePacklist = (id, data) => {
    setPacklists(packlists.map((p) => (p.id === id ? { ...p, ...data } : p)));
    setEditingId(null);
    setTab("saved");
  };
  const deletePacklist = (id) => {
    setPacklists(packlists.filter((p) => p.id !== id));
    if (openId === id) setOpenId(null);
  };

  // Inventory-level updaters — used by edit modals on the detail view.
  // Same shape as Inventory's own updaters; changes flow back to the
  // shared state so the packlist re-renders with new data.
  const updateItem = (id, data) =>
    setItems(items.map((i) => (i.id === id ? { ...i, ...data } : i)));
  const addItem = (item) =>
    setItems([item, ...items]);
  const deleteItem = (id) => {
    setItems(items.filter((i) => i.id !== id));
    // Cascade: also remove from any kits referencing it
    setKits(kits.map((k) => (k.itemIds || []).includes(id)
      ? { ...k, itemIds: k.itemIds.filter((x) => x !== id) }
      : k));
    // And from packlists' item lists
    setPacklists(packlists.map((p) => (p.itemIds || []).includes(id)
      ? { ...p, itemIds: p.itemIds.filter((x) => x !== id) }
      : p));
  };
  const updateKit = (kit) =>
    setKits(kits.map((k) => (k.id === kit.id ? { ...k, ...kit } : k)));
  const updateCategory = (id, data) =>
    setCategories(categories.map((c) => (c.id === id ? { ...c, ...data } : c)));

  // Remove a single item or kit from an existing packlist (used by detail view)
  const removeItemFromPacklist = (plId, itemId) => {
    setPacklists(packlists.map((p) =>
      p.id === plId ? { ...p, itemIds: (p.itemIds || []).filter((x) => x !== itemId) } : p
    ));
  };
  const removeKitFromPacklist = (plId, kitId) => {
    setPacklists(packlists.map((p) =>
      p.id === plId ? { ...p, kitIds: (p.kitIds || []).filter((x) => x !== kitId) } : p
    ));
  };
  const removeCategoryFromPacklist = (plId, catId) => {
    setPacklists(packlists.map((p) =>
      p.id === plId ? { ...p, categoryIds: (p.categoryIds || []).filter((x) => x !== catId) } : p
    ));
  };

  // Toggle "want to take" state for an item on a specific packlist.
  // Stores arrays of item IDs on the packlist itself so each trip has its
  // own state independent of others.
  const toggleWanted = (plId, itemId) => {
    setPacklists(packlists.map((p) => {
      if (p.id !== plId) return p;
      const list = p.wantedItemIds || [];
      const next = list.includes(itemId) ? list.filter((x) => x !== itemId) : [...list, itemId];
      return { ...p, wantedItemIds: next };
    }));
  };
  // Toggle "is packed" state for an item on a specific packlist.
  const togglePackedOnPacklist = (plId, itemId) => {
    setPacklists(packlists.map((p) => {
      if (p.id !== plId) return p;
      const list = p.packedItemIds || [];
      const next = list.includes(itemId) ? list.filter((x) => x !== itemId) : [...list, itemId];
      return { ...p, packedItemIds: next };
    }));
  };

  const startEdit = (id) => { setEditingId(id); setTab("edit"); setOpenId(null); };
  const editingPacklist = editingId ? packlists.find((p) => p.id === editingId) : null;
  const openPacklist = openId ? packlists.find((p) => p.id === openId) : null;

  // Detail view
  if (openPacklist) {
    const editorPacklist = editorOpenId ? packlists.find((p) => p.id === editorOpenId) : null;
    return (
      <div>
        <Header go={go} active="packlists" />
        <div style={{ padding: padX(isMobile) }}>
          <PacklistDetail
            packlist={openPacklist}
            kits={kits}
            items={items}
            categories={categories}
            onBack={() => setOpenId(null)}
            onEdit={() => setEditorOpenId(openPacklist.id)}
            onDelete={() => deletePacklist(openPacklist.id)}
            onRemoveItem={(itemId) => removeItemFromPacklist(openPacklist.id, itemId)}
            onRemoveKit={(kitId) => removeKitFromPacklist(openPacklist.id, kitId)}
            onRemoveCategory={(catId) => removeCategoryFromPacklist(openPacklist.id, catId)}
            onEditItem={(id) => setDetailItemId(id)}
            onEditKit={(id) => setDetailKitId(id)}
            onEditCategory={(id) => setDetailCategoryId(id)}
            onToggleWanted={(itemId) => toggleWanted(openPacklist.id, itemId)}
            onTogglePacked={(itemId) => togglePackedOnPacklist(openPacklist.id, itemId)}
          />
        </div>
        <Footer />
        {editorPacklist && (
          <PacklistEditorDialog
            packlist={editorPacklist}
            categories={categories} setCategories={setCategories}
            kits={kits} setKits={setKits}
            items={items} setItems={setItems}
            travelTypes={travelTypes} setTravelTypes={setTravelTypes}
            onSave={(data) => { updatePacklist(editorOpenId, data); setEditorOpenId(null); }}
            onClose={() => setEditorOpenId(null)}
          />
        )}

        {/* === KIT DETAIL — items inside, add/remove === */}
        {detailKitId && (() => {
          const k = kits.find((x) => x.id === detailKitId);
          if (!k) return null;
          return (
            <KitDetailModal
              kit={k}
              items={items}
              categories={categories}
              onUpdateKit={updateKit}
              onUpdateItem={updateItem}
              onAddItem={addItem}
              onEditItem={(id) => setDetailItemId(id)}
              onClose={() => setDetailKitId(null)}
            />
          );
        })()}

        {/* === CATEGORY DETAIL — items in this category === */}
        {detailCategoryId && (() => {
          const c = categories.find((x) => x.id === detailCategoryId);
          if (!c) return null;
          return (
            <CategoryDetailModal
              category={c}
              items={items}
              kits={kits}
              categories={categories}
              onUpdateItem={updateItem}
              onAddItem={addItem}
              onEditItem={(id) => setDetailItemId(id)}
              onEditKit={(id) => setDetailKitId(id)}
              onClose={() => setDetailCategoryId(null)}
            />
          );
        })()}

        {/* === ITEM DETAIL — view + Edit/Delete buttons === */}
        {detailItemId && (() => {
          const it = items.find((x) => x.id === detailItemId);
          if (!it) return null;
          return (
            <ItemDetailModal
              item={it}
              onClose={() => setDetailItemId(null)}
              onEdit={() => { setFormItemId(detailItemId); setDetailItemId(null); }}
              onDelete={() => { deleteItem(detailItemId); }}
            />
          );
        })()}

        {/* === ITEM FORM — full edit, opened from ItemDetailModal's Edit button === */}
        {formItemId && (() => {
          const it = items.find((x) => x.id === formItemId);
          if (!it) return null;
          return (
            <Modal title={t("form.editItemTitle")} onClose={() => setFormItemId(null)}>
              <AddItemForm
                categories={categories}
                initial={it}
                onAdd={(data) => { updateItem(formItemId, data); setFormItemId(null); }}
                onCancel={() => setFormItemId(null)}
              />
            </Modal>
          );
        })()}
      </div>
    );
  }

  return (
    <div>
      <Header go={go} active="packlists" />
      <div style={{ padding: padX(isMobile) }}>
        <div style={{ marginTop: isMobile ? 24 : 40 }}>
          <Coord>{t("pl.section")}</Coord>
          <h1 style={{ margin: "12px 0", fontFamily: F.display, fontSize: "clamp(36px, 6vw, 72px)", fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 0.95 }}>
            {t("pl.titleA")} <span style={{ fontStyle: "italic", color: C.forest }}>{t("pl.titleB")}</span><span style={{ color: C.rust }}>.</span>
          </h1>
          <div style={{ marginTop: 6, fontFamily: F.display, fontStyle: "italic", color: C.inkSoft, fontSize: isMobile ? 15 : 17 }}>
            {t("pl.tagline")}
          </div>
        </div>

        <div style={{ marginTop: isMobile ? 24 : 40, display: "flex", flexDirection: isMobile ? "column" : "row", justifyContent: "space-between", alignItems: isMobile ? "stretch" : "flex-end", gap: isMobile ? 14 : 16 }}>
          <div style={{ display: "flex", borderBottom: `1.5px solid ${C.ink}`, overflowX: "auto", WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}>
            {[["saved", t("pl.tabSaved", { n: packlists.length })], ["create", t("pl.tabCreate")]].map(([k, l]) => (
              <button key={k} onClick={() => { setTab(k); setEditingId(null); }}
                style={{ padding: isMobile ? "10px 14px" : "12px 20px", border: "none", cursor: "pointer", fontFamily: F.mono, fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", background: tab === k || (k === "create" && tab === "edit") ? C.ink : "transparent", color: tab === k || (k === "create" && tab === "edit") ? C.paper : C.ink, fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 }}>
                {l}
              </button>
            ))}
          </div>
          {tab === "saved" && (
            <Btn variant="rust" icon={Plus} onClick={() => setTab("create")} fullWidth={isMobile}>
              {t("pl.add")}
            </Btn>
          )}
        </div>

        <div style={{ marginTop: isMobile ? 20 : 32 }}>
          {tab === "saved" && (
            <PacklistsList
              packlists={packlists}
              kits={kits}
              items={items}
              onOpen={(id) => setOpenId(id)}
              onEdit={(id) => setEditorOpenId(id)}
              onDelete={deletePacklist}
              onCreate={() => setTab("create")}
            />
          )}
          {tab === "create" && (
            <TripPacklistForm
              kits={kits} setKits={setKits}
              items={items} setItems={setItems}
              categories={categories} setCategories={setCategories}
              travelTypes={travelTypes} setTravelTypes={setTravelTypes}
              onSubmit={addPacklist}
              onCancel={() => setTab("saved")}
            />
          )}
          {tab === "edit" && editingPacklist && (
            <TripPacklistForm
              initial={editingPacklist}
              kits={kits} setKits={setKits}
              items={items} setItems={setItems}
              categories={categories} setCategories={setCategories}
              travelTypes={travelTypes} setTravelTypes={setTravelTypes}
              onSubmit={(data) => updatePacklist(editingPacklist.id, data)}
              onCancel={() => { setEditingId(null); setTab("saved"); }}
            />
          )}
        </div>
      </div>
      <Footer />
      {editorOpenId && (() => {
        const editorPacklist = packlists.find((p) => p.id === editorOpenId);
        if (!editorPacklist) return null;
        return (
          <PacklistEditorDialog
            packlist={editorPacklist}
            categories={categories} setCategories={setCategories}
            kits={kits} setKits={setKits}
            items={items} setItems={setItems}
            travelTypes={travelTypes} setTravelTypes={setTravelTypes}
            onSave={(data) => { updatePacklist(editorOpenId, data); setEditorOpenId(null); }}
            onClose={() => setEditorOpenId(null)}
          />
        );
      })()}
    </div>
  );
}

/* List of packlist cards */
function PacklistsList({ packlists, kits, items, onOpen, onEdit, onDelete, onCreate }) {
  const { t } = useI18n();
  const { isMobile } = useViewport();
  const [confirmingId, setConfirmingId] = useState(null);

  if (packlists.length === 0) {
    return (
      <div style={{ padding: isMobile ? 32 : 48, textAlign: "center", border: `1.5px dashed ${C.line}`, background: C.paperDeep }}>
        <div style={{ fontFamily: F.display, fontStyle: "italic", fontSize: isMobile ? 20 : 24, color: C.inkSoft }}>{t("pl.empty")}</div>
        <div style={{ marginTop: 8, marginBottom: 24, fontFamily: F.mono, fontSize: 11, letterSpacing: "0.15em", color: C.muted, textTransform: "uppercase" }}>{t("pl.emptyHint")}</div>
        <Btn variant="rust" icon={Plus} onClick={onCreate} fullWidth={isMobile}>{t("pl.add")}</Btn>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 16 }}>
      {packlists.map((p) => {
        const kitCount = p.kitIds.length;
        const itemCount = p.itemIds.length;
        // Calculate total unique items: items in selected kits + standalone items
        const idsInKits = new Set();
        p.kitIds.forEach((kid) => {
          const k = kits.find((kk) => kk.id === kid);
          if (k) k.itemIds.forEach((iid) => idsInKits.add(iid));
        });
        p.itemIds.forEach((iid) => idsInKits.add(iid));
        const totalUnique = idsInKits.size;
        const kitsLabel = kitCount === 1 ? t("pl.kitsCount_one") : t("pl.kitsCount_many", { n: kitCount });
        const itemsLabel = itemCount === 1 ? t("pl.itemsCount_one") : t("pl.itemsCount_many", { n: itemCount });
        const isConfirming = confirmingId === p.id;

        return (
          <div key={p.id} style={{ background: C.paper, border: `1.5px solid ${C.ink}`, padding: isMobile ? 16 : 20, position: "relative", display: "flex", flexDirection: "column" }}>
            <Coord>PACKLIST</Coord>
            <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 12 }}>
              {p.type && <TripTypeBadge iconKey={getTripType(p.type)?.icon || "other"} size={isMobile ? 36 : 44} />}
              <div style={{ flex: 1, minWidth: 0, fontFamily: F.display, fontSize: isMobile ? 22 : 26, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05, paddingRight: 4 }}>
                {p.name}
              </div>
            </div>
            <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
              {kitsLabel}{itemCount > 0 ? `  /  ${itemsLabel}` : ""}{totalUnique > 0 ? `  /  ${t("pl.totalUnique", { n: totalUnique })}` : ""}
            </div>
            {p.notes && (
              <div style={{ marginTop: 10, fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.inkSoft, lineHeight: 1.4 }}>
                {p.notes}
              </div>
            )}

            <div style={{ flex: 1 }} />

            <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
              <Btn variant="rust" icon={ChevronRight} onClick={() => onOpen(p.id)} fullWidth={true}>
                {t("pl.openBtn")}
              </Btn>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn variant="ghost" icon={Pencil} onClick={() => onEdit(p.id)} fullWidth={true}>
                  {t("pl.editBtn")}
                </Btn>
                <button
                  onClick={() => setConfirmingId(isConfirming ? null : p.id)}
                  style={{
                    width: 44, minWidth: 44, height: 44,
                    cursor: "pointer",
                    background: isConfirming ? C.rust : "transparent",
                    border: `1.5px solid ${C.rust}`,
                    color: isConfirming ? C.paper : C.rust,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                  aria-label={t("pl.deleteBtn")}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>

            {isConfirming && (
              <div style={{ marginTop: 12, padding: 12, background: C.paperDeep, border: `1.5px dashed ${C.rust}` }}>
                <div style={{ fontFamily: F.body, fontSize: 13, color: C.inkSoft, marginBottom: 10 }}>
                  {t("pl.confirmDelete")}
                </div>
                <div style={{ display: "flex", gap: 8, flexDirection: isMobile ? "column-reverse" : "row" }}>
                  <Btn variant="ghost" icon={X} onClick={() => setConfirmingId(null)} fullWidth={isMobile}>{t("common.cancel")}</Btn>
                  <Btn variant="rust" icon={Trash2} onClick={() => { onDelete(p.id); setConfirmingId(null); }} fullWidth={isMobile}>{t("pl.confirmYes")}</Btn>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* The form for creating + editing packlists */
function PacklistForm({ initial, kits, items, categories, onSubmit, onCancel }) {
  const { t, lang, units } = useI18n();
  const { isMobile } = useViewport();
  const editMode = !!initial;
  const [name, setName] = useState(initial?.name || "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [kitIds, setKitIds] = useState(initial?.kitIds || []);
  const [itemIds, setItemIds] = useState(initial?.itemIds || []);

  const toggleKit = (id) => setKitIds(kitIds.includes(id) ? kitIds.filter((x) => x !== id) : [...kitIds, id]);
  const toggleItem = (id) => setItemIds(itemIds.includes(id) ? itemIds.filter((x) => x !== id) : [...itemIds, id]);

  const submit = () => {
    if (!name.trim()) return;
    onSubmit({ name: name.trim(), notes: notes.trim(), kitIds, itemIds });
  };

  return (
    <AddPanel
      title={editMode ? t("pl.editFormTitle") : t("pl.formTitle")}
      onSave={submit}
      onCancel={onCancel}
      saveLabel={editMode ? t("pl.saveBtn") : t("pl.fileBtn")}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        <Field
          label={t("trips.tripName")}
          icon={Backpack}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("pl.namePh")}
        />
        <label style={{ display: "block" }}>
          <div style={{ marginBottom: 8, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
            {t("pl.notes")}
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("pl.notesPh")}
            rows={3}
            style={{
              width: "100%",
              padding: "10px 0",
              background: "transparent",
              border: "none",
              borderBottom: `1.5px solid ${C.ink}`,
              outline: "none",
              fontFamily: F.body,
              fontSize: 16,
              color: C.ink,
              resize: "vertical",
            }}
          />
        </label>

        {/* KITS picker */}
        <div style={{ marginTop: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, paddingBottom: 6, borderBottom: `1px dashed ${C.line}` }}>
            <div>
              <span style={{ fontFamily: F.display, fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>{t("pl.kitsHeading")}</span>
              <span style={{ marginLeft: 8, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>{kitIds.length} / {kits.length}</span>
            </div>
          </div>
          <div style={{ marginBottom: 10, fontFamily: F.body, fontSize: 12, color: C.muted, fontStyle: "italic" }}>
            {t("pl.kitsHint")}
          </div>
          {kits.length === 0 ? (
            <div style={{ padding: 14, background: C.paperDeep, border: `1px dashed ${C.line}`, textAlign: "center" }}>
              <div style={{ fontFamily: F.display, fontStyle: "italic", fontSize: 14, color: C.inkSoft }}>{t("pl.noKits")}</div>
              <div style={{ marginTop: 4, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>{t("pl.noKitsHint")}</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 240, overflowY: "auto", paddingRight: 4 }}>
              {kits.map((k) => {
                const sel = kitIds.includes(k.id);
                const itemCount = k.itemIds.length;
                return (
                  <button
                    key={k.id}
                    onClick={() => toggleKit(k.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "10px 12px",
                      background: sel ? C.paper : "transparent",
                      border: `1.5px solid ${sel ? C.forest : C.line}`,
                      cursor: "pointer",
                      textAlign: "left",
                      width: "100%",
                    }}
                  >
                    <span style={{
                      width: 22, height: 22, flexShrink: 0,
                      border: `1.5px solid ${sel ? C.forest : C.muted}`,
                      background: sel ? C.forest : "transparent",
                      color: C.paper,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                    }}>
                      {sel && <Check size={13} strokeWidth={3} />}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: F.display, fontSize: 15, fontWeight: 600, color: C.ink, lineHeight: 1.2 }}>{k.name}</div>
                      <div style={{ marginTop: 2, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                        {itemCount} {itemCount === 1 ? "item" : "items"}{k.category ? `  /  ${tOrLiteral(lang, "cat", k.category)}` : ""}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ITEMS picker */}
        <div style={{ marginTop: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, paddingBottom: 6, borderBottom: `1px dashed ${C.line}` }}>
            <div>
              <span style={{ fontFamily: F.display, fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>{t("pl.itemsHeading")}</span>
              <span style={{ marginLeft: 8, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>{itemIds.length} / {items.length}</span>
            </div>
          </div>
          <div style={{ marginBottom: 10, fontFamily: F.body, fontSize: 12, color: C.muted, fontStyle: "italic" }}>
            {t("pl.itemsHint")}
          </div>
          {items.length === 0 ? (
            <div style={{ padding: 14, background: C.paperDeep, border: `1px dashed ${C.line}`, textAlign: "center" }}>
              <div style={{ fontFamily: F.display, fontStyle: "italic", fontSize: 14, color: C.inkSoft }}>{t("pl.noItems")}</div>
              <div style={{ marginTop: 4, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>{t("pl.noItemsHint")}</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 280, overflowY: "auto", paddingRight: 4 }}>
              {items.map((it) => {
                const sel = itemIds.includes(it.id);
                return (
                  <button
                    key={it.id}
                    onClick={() => toggleItem(it.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "8px 12px",
                      background: sel ? C.paper : "transparent",
                      border: `1.5px solid ${sel ? C.forest : C.line}`,
                      cursor: "pointer",
                      textAlign: "left",
                      width: "100%",
                    }}
                  >
                    <span style={{
                      width: 20, height: 20, flexShrink: 0,
                      border: `1.5px solid ${sel ? C.forest : C.muted}`,
                      background: sel ? C.forest : "transparent",
                      color: C.paper,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                    }}>
                      {sel && <Check size={12} strokeWidth={3} />}
                    </span>
                    <span style={{ flex: 1, fontFamily: F.body, fontSize: 14, fontWeight: 500, color: C.ink, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</span>
                    <span style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase", flexShrink: 0 }}>
                      {tOrLiteral(lang, "cat", it.category)}  /  {formatWeight(it.weight, units)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </AddPanel>
  );
}

/* ============================================================
   TripPacklistForm — unified create/edit wizard for the merged
   Trip/Packlist entity. Two steps:
     1) Itinerary — name, dates, destination, type
     2) Pack — categories, kits, individual items (with inline-create)
   Used for both creating new entries and editing existing ones.
   ============================================================ */
function TripPacklistForm({
  initial,                 // existing packlist for edit mode (or null for create)
  kits, setKits,
  items, setItems,
  categories, setCategories,
  travelTypes, setTravelTypes,
  onSubmit, onCancel,
}) {
  const { t, locale, lang } = useI18n();
  const { isMobile } = useViewport();
  const editMode = !!initial;

  // Two-step wizard
  const [step, setStep] = useState(1);

  // Step 1 — itinerary metadata. All optional except name.
  const [name, setName] = useState(initial?.name || "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [dest, setDest] = useState(initial?.dest || "");
  // We store dates as a single 'date' string (e.g. "Jun 12 - Jun 26") to match
  // existing trip data shape. Internally we keep two date inputs and format.
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [type, setType] = useState(initial?.type || "");
  const [addingType, setAddingType] = useState(false);
  const [newType, setNewType] = useState({ name: "", climate: "", days: "" });

  // Step 2 — packing selections. categoryIds, kitIds, itemIds.
  const [pickedCategoryIds, setPickedCategoryIds] = useState(initial?.categoryIds || []);
  const [pickedKitIds, setPickedKitIds] = useState(initial?.kitIds || []);
  const [pickedItemIds, setPickedItemIds] = useState(initial?.itemIds || []);

  // Inline-create UI state
  const [inlineMode, setInlineMode] = useState(null); // "item" | "kit" | "cat" | null
  // Whether the "create new" form is expanded inside the picker. Hidden by
  // default so the existing-items list is the obvious primary action and the
  // misleading inline "Save" button doesn't compete with the bottom Save.
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newItem, setNewItem] = useState({ name: "", weight: "", category: "" });
  const [newKit, setNewKit] = useState({ name: "", category: "" });
  const [newCat, setNewCat] = useState({ name: "" });
  const [searchItems, setSearchItems] = useState("");
  const [searchKits, setSearchKits] = useState("");
  const [searchCats, setSearchCats] = useState("");

  const fmt = (d) => {
    if (!d) return "";
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return d;
    return dt.toLocaleDateString(locale, { month: "short", day: "2-digit" });
  };

  // Toggling helpers
  const toggleCategory = (id) =>
    setPickedCategoryIds((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  const toggleKit = (id) =>
    setPickedKitIds((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  const toggleItem = (id) =>
    setPickedItemIds((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);

  // Filtered lists for search
  const filteredCats = searchCats.trim()
    ? categories.filter((c) => c.name.toLowerCase().includes(searchCats.toLowerCase()))
    : categories;
  const filteredKits = searchKits.trim()
    ? kits.filter((k) => k.name.toLowerCase().includes(searchKits.toLowerCase()))
    : kits;
  const filteredItems = searchItems.trim()
    ? items.filter((i) => i.name.toLowerCase().includes(searchItems.toLowerCase()))
    : items;

  // === Inline create handlers ===
  const saveInlineItem = () => {
    const itemName = newItem.name.trim();
    if (!itemName) return;
    const id = uid("it");
    const created = {
      id, name: itemName,
      category: newItem.category || (categories[0]?.name || "Other"),
      weight: newItem.weight.trim() || "0 g",
      quantity: 1, packed: false, consumable: false,
      expiry: "", remindDays: null,
    };
    setItems([created, ...items]);
    setPickedItemIds((s) => [...s, id]);
    setNewItem({ name: "", weight: "", category: "" });
    setInlineMode(null);
  };

  const saveInlineKit = () => {
    const kitName = newKit.name.trim();
    if (!kitName) return;
    const id = uid("kit");
    const created = { id, name: kitName, category: newKit.category || "", itemIds: [] };
    setKits([created, ...kits]);
    setPickedKitIds((s) => [...s, id]);
    setNewKit({ name: "", category: "" });
    setInlineMode(null);
  };

  const saveInlineCat = () => {
    const catName = newCat.name.trim();
    if (!catName) return;
    const id = uid("cat");
    const created = { id, name: catName, icon: "tag" };
    setCategories([created, ...categories]);
    setPickedCategoryIds((s) => [...s, id]);
    setNewCat({ name: "" });
    setInlineMode(null);
  };

  const saveNewType = () => {
    const tName = newType.name.trim();
    if (!tName) return;
    setTravelTypes([{ id: uid("tt"), icon: "mountain", name: tName, climate: newType.climate.trim() || "Variable", days: newType.days.trim() || "1-7" }, ...travelTypes]);
    setType(tName);
    setNewType({ name: "", climate: "", days: "" });
    setAddingType(false);
  };

  // === Submit ===
  const submit = () => {
    if (!name.trim()) return;
    // Build the date string from start/end (only update if user actually entered new dates)
    let dateString = initial?.date || "";
    if (start && end) dateString = `${fmt(start)} - ${fmt(end)}`;
    else if (start) dateString = fmt(start);

    onSubmit({
      name: name.trim(),
      notes: notes.trim(),
      dest: dest.trim(),
      date: dateString,
      type: type || "",
      kitIds: pickedKitIds,
      itemIds: pickedItemIds,
      categoryIds: pickedCategoryIds,
    });
  };

  // ============== STEP 1 ==============
  if (step === 1) {
    return (
      <div style={{ maxWidth: 720 }}>
        <div style={{ marginBottom: 14, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
          {t("trips.step1")}  ·  {t("trips.stepDetailsTitle")}
        </div>
        <SectionHeader num="A" label={t("trips.itinerary")} right={editMode ? "EDIT" : t("trips.formCode")} />
        <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 22 : 28 }}>
          <Field label={t("trips.tripName")} icon={MapPin} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("trips.tripNamePh")} />
          <Field label={t("trips.destination")} icon={Globe} value={dest} onChange={(e) => setDest(e.target.value)} placeholder={t("trips.destinationPh")} />
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: isMobile ? 18 : 24 }}>
            <Field label={t("trips.startDate")} type="date" icon={Calendar} value={start} onChange={(e) => setStart(e.target.value)} />
            <Field label={t("trips.endDate")} type="date" icon={Calendar} value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>

          {/* Trip type — custom dropdown */}
          <div>
            <div style={{ marginBottom: 10, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
              {t("trips.tripType")}
            </div>
            <TripTypeSelect value={type} onChange={(v) => setType(v)} />
          </div>

          {/* Notes */}
          <label style={{ display: "block" }}>
            <div style={{ marginBottom: 8, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
              {t("pl.notes")}
            </div>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("pl.notesPh")} rows={3}
              style={{ width: "100%", padding: "10px 0", background: "transparent", border: "none", borderBottom: `1.5px solid ${C.ink}`, outline: "none", fontFamily: F.body, fontSize: 16, color: C.ink, resize: "vertical" }} />
          </label>
        </div>
        <div style={{ marginTop: isMobile ? 28 : 40, display: "flex", gap: 10, flexDirection: isMobile ? "column-reverse" : "row" }}>
          <Btn variant="ghost" icon={X} onClick={onCancel} fullWidth={isMobile}>{t("common.cancel")}</Btn>
          <Btn onClick={() => name.trim() && setStep(2)} variant="rust" icon={ChevronRight} fullWidth={isMobile} disabled={!name.trim()}>
            {t("trips.next")}
          </Btn>
        </div>
      </div>
    );
  }

  // ============== STEP 2 ==============
  const summaryText = (pickedCategoryIds.length || pickedKitIds.length || pickedItemIds.length)
    ? t("trips.summaryFmt", { c: pickedCategoryIds.length, k: pickedKitIds.length, i: pickedItemIds.length })
    : t("trips.summaryNothing");

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ marginBottom: 14, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
        {t("trips.step2")}  ·  {t("trips.stepPackTitle")}
      </div>
      <SectionHeader num="B" label={t("trips.stepPackTitle")} right={editMode ? "EDIT" : t("trips.formCode")} />
      <div style={{ marginBottom: 18, fontFamily: F.body, fontStyle: "italic", color: C.inkSoft, fontSize: 14 }}>
        {t("trips.stepPackSub")}
      </div>

      {/* Live summary */}
      <div style={{ padding: "10px 14px", background: C.ink, color: C.paper, marginBottom: 24, fontFamily: F.mono, fontSize: 11, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700 }}>
        {t("trips.summarySection")}: <span style={{ marginLeft: 6, opacity: 0.85 }}>{summaryText}</span>
      </div>

      {/* === QUICK ADD TOOLBAR (prominent, at top — same style as edit dialog) === */}
      <div style={{
        marginBottom: 28, padding: isMobile ? 14 : 18,
        background: C.paperDeep,
        border: `2px solid ${C.rust}`,
        boxShadow: `inset 0 0 0 1px ${C.paper}`,
      }}>
        <div style={{
          marginBottom: 12, fontFamily: F.mono, fontSize: 11,
          color: C.rust, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 700,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <Plus size={14} strokeWidth={2.5} /> {t("trips.unifiedQuickAdd")}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: 8 }}>
          {[
            ["item", t("trips.addNewItemInline"), items.length],
            ["kit", t("trips.addNewKitInline"), kits.length],
            ["cat", t("trips.addNewCatInline"), categories.length],
          ].map(([k, label, count]) => {
            const active = inlineMode === k;
            return (
              <button key={k} onClick={() => { setInlineMode(active ? null : k); setShowCreateForm(false); }}
                style={{
                  padding: isMobile ? "12px 14px" : "14px 16px",
                  border: `1.5px solid ${active ? C.rust : C.ink}`,
                  background: active ? C.rust : C.paper,
                  color: active ? C.paper : C.ink,
                  cursor: "pointer",
                  fontFamily: F.mono, fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 700,
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                  minHeight: 44,
                }}>
                {active ? <X size={14} strokeWidth={2.5} /> : <Plus size={14} strokeWidth={2.5} />}
                {label.replace(/^\+\s*/, "")}
                <span style={{ marginLeft: 4, opacity: 0.7, fontWeight: 500 }}>({count})</span>
              </button>
            );
          })}
        </div>

        {/* === ITEM PICKER === */}
        {inlineMode === "item" && (
          <div style={{ marginTop: 14 }}>
            {/* Existing items list */}
            <div style={{ padding: 12, background: C.paper, border: `1.5px solid ${C.ink}`, marginBottom: 10 }}>
              <div style={{ marginBottom: 10, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
                {t("qadd.pickFromList")} — {items.length}
              </div>
              {items.length === 0 ? (
                <div style={{ padding: "10px 0", fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.inkSoft }}>
                  {t("qadd.emptyItems")}
                </div>
              ) : (
                <div style={{ maxHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                  {items.map((it) => {
                    const sel = pickedItemIds.includes(it.id);
                    return (
                      <button key={it.id}
                        onClick={() => setPickedItemIds(sel ? pickedItemIds.filter((x) => x !== it.id) : [...pickedItemIds, it.id])}
                        style={{
                          display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                          background: sel ? C.paperDeep : "transparent",
                          border: `1px solid ${sel ? C.forest : C.line}`,
                          cursor: "pointer", textAlign: "left",
                        }}>
                        <span style={{ width: 18, height: 18, flexShrink: 0, border: `1.5px solid ${sel ? C.forest : C.muted}`, background: sel ? C.forest : "transparent", color: C.paper, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                          {sel && <Check size={11} strokeWidth={3} />}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontFamily: F.body, fontSize: 14, fontWeight: 500, color: C.ink }}>{it.name}</div>
                          <div style={{ marginTop: 1, fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                            {it.category || t("trips.unifiedNoCategory")}{it.weight ? ` · ${it.weight}` : ""}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {/* Create new item — collapsed by default */}
            {!showCreateForm ? (
              <button onClick={() => setShowCreateForm(true)}
                style={{
                  width: "100%", padding: "12px 14px",
                  background: "transparent", border: `1.5px dashed ${C.rust}`,
                  color: C.rust, cursor: "pointer",
                  fontFamily: F.mono, fontSize: 11, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700,
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                }}>
                <Plus size={14} strokeWidth={2.5} />
                {t("qadd.orCreateItem")}
              </button>
            ) : (
              <div style={{ padding: 12, background: C.paper, border: `1.5px dashed ${C.rust}` }}>
                <div style={{ marginBottom: 10, fontFamily: F.mono, fontSize: 10, color: C.rust, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
                  + {t("trips.addNewItemInline").replace(/^\+\s*/, "")}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <Field label={t("trips.inlineItemName")} value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} />
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12 }}>
                    <Field label={t("trips.inlineItemWeight")} value={newItem.weight} onChange={(e) => setNewItem({ ...newItem, weight: e.target.value })} placeholder="0.5 kg" />
                    <CategorySelect categories={categories} value={newItem.category} onChange={(v) => setNewItem({ ...newItem, category: v })} />
                  </div>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <Btn variant="ghost" icon={X} onClick={() => { setShowCreateForm(false); setNewItem({ name: "", weight: "", category: "" }); }}>{t("trips.inlineCancel")}</Btn>
                    <Btn variant="rust" icon={Check} onClick={() => { saveInlineItem(); setShowCreateForm(false); }} disabled={!newItem.name.trim()}>{t("trips.inlineSave")}</Btn>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* === KIT PICKER === */}
        {inlineMode === "kit" && (
          <div style={{ marginTop: 14 }}>
            <div style={{ padding: 12, background: C.paper, border: `1.5px solid ${C.ink}`, marginBottom: 10 }}>
              <div style={{ marginBottom: 10, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
                {t("qadd.pickFromList")} — {kits.length}
              </div>
              {kits.length === 0 ? (
                <div style={{ padding: "10px 0", fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.inkSoft }}>
                  {t("qadd.emptyKits")}
                </div>
              ) : (
                <div style={{ maxHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                  {kits.map((k) => {
                    const sel = pickedKitIds.includes(k.id);
                    const itemCount = (k.itemIds || []).length;
                    return (
                      <button key={k.id}
                        onClick={() => setPickedKitIds(sel ? pickedKitIds.filter((x) => x !== k.id) : [...pickedKitIds, k.id])}
                        style={{
                          display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                          background: sel ? C.paperDeep : "transparent",
                          border: `1px solid ${sel ? C.forest : C.line}`,
                          cursor: "pointer", textAlign: "left",
                        }}>
                        <span style={{ width: 18, height: 18, flexShrink: 0, border: `1.5px solid ${sel ? C.forest : C.muted}`, background: sel ? C.forest : "transparent", color: C.paper, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                          {sel && <Check size={11} strokeWidth={3} />}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontFamily: F.body, fontSize: 14, fontWeight: 500, color: C.ink }}>{k.name}</div>
                          <div style={{ marginTop: 1, fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                            {k.category || t("trips.unifiedNoCategory")} · {itemCount} {itemCount === 1 ? "item" : "items"}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {!showCreateForm ? (
              <button onClick={() => setShowCreateForm(true)}
                style={{
                  width: "100%", padding: "12px 14px",
                  background: "transparent", border: `1.5px dashed ${C.rust}`,
                  color: C.rust, cursor: "pointer",
                  fontFamily: F.mono, fontSize: 11, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700,
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                }}>
                <Plus size={14} strokeWidth={2.5} />
                {t("qadd.orCreateKit")}
              </button>
            ) : (
              <div style={{ padding: 12, background: C.paper, border: `1.5px dashed ${C.rust}` }}>
                <div style={{ marginBottom: 10, fontFamily: F.mono, fontSize: 10, color: C.rust, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
                  + {t("trips.addNewKitInline").replace(/^\+\s*/, "")}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <Field label={t("trips.inlineKitName")} value={newKit.name} onChange={(e) => setNewKit({ ...newKit, name: e.target.value })} />
                  <CategorySelect categories={categories} value={newKit.category} onChange={(v) => setNewKit({ ...newKit, category: v })} />
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <Btn variant="ghost" icon={X} onClick={() => { setShowCreateForm(false); setNewKit({ name: "", category: "" }); }}>{t("trips.inlineCancel")}</Btn>
                    <Btn variant="rust" icon={Check} onClick={() => { saveInlineKit(); setShowCreateForm(false); }} disabled={!newKit.name.trim()}>{t("trips.inlineSave")}</Btn>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* === CATEGORY PICKER === */}
        {inlineMode === "cat" && (
          <div style={{ marginTop: 14 }}>
            <div style={{ padding: 12, background: C.paper, border: `1.5px solid ${C.ink}`, marginBottom: 10 }}>
              <div style={{ marginBottom: 10, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
                {t("qadd.pickFromList")} — {categories.length}
              </div>
              {categories.length === 0 ? (
                <div style={{ padding: "10px 0", fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.inkSoft }}>
                  {t("qadd.emptyCats")}
                </div>
              ) : (
                <div style={{ maxHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                  {categories.map((c) => {
                    const sel = pickedCategoryIds.includes(c.id);
                    const itemsInCat = items.filter((i) => i.category === c.name).length;
                    return (
                      <button key={c.id}
                        onClick={() => setPickedCategoryIds(sel ? pickedCategoryIds.filter((x) => x !== c.id) : [...pickedCategoryIds, c.id])}
                        style={{
                          display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                          background: sel ? C.paperDeep : "transparent",
                          border: `1px solid ${sel ? C.forest : C.line}`,
                          cursor: "pointer", textAlign: "left",
                        }}>
                        <span style={{ width: 18, height: 18, flexShrink: 0, border: `1.5px solid ${sel ? C.forest : C.muted}`, background: sel ? C.forest : "transparent", color: C.paper, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                          {sel && <Check size={11} strokeWidth={3} />}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontFamily: F.body, fontSize: 14, fontWeight: 500, color: C.ink }}>{c.name}</div>
                          <div style={{ marginTop: 1, fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                            {itemsInCat} {itemsInCat === 1 ? "item" : "items"}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {!showCreateForm ? (
              <button onClick={() => setShowCreateForm(true)}
                style={{
                  width: "100%", padding: "12px 14px",
                  background: "transparent", border: `1.5px dashed ${C.rust}`,
                  color: C.rust, cursor: "pointer",
                  fontFamily: F.mono, fontSize: 11, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700,
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                }}>
                <Plus size={14} strokeWidth={2.5} />
                {t("qadd.orCreateCat")}
              </button>
            ) : (
              <div style={{ padding: 12, background: C.paper, border: `1.5px dashed ${C.rust}` }}>
                <div style={{ marginBottom: 10, fontFamily: F.mono, fontSize: 10, color: C.rust, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
                  + {t("trips.addNewCatInline").replace(/^\+\s*/, "")}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <Field label={t("trips.inlineCatName")} value={newCat.name} onChange={(e) => setNewCat({ name: e.target.value })} />
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <Btn variant="ghost" icon={X} onClick={() => { setShowCreateForm(false); setNewCat({ name: "" }); }}>{t("trips.inlineCancel")}</Btn>
                    <Btn variant="rust" icon={Check} onClick={() => { saveInlineCat(); setShowCreateForm(false); }} disabled={!newCat.name.trim()}>{t("trips.inlineSave")}</Btn>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* === PICKED ITEMS / KITS / CATEGORIES SUMMARY === */}
      <PacklistPickedSummary
        categories={categories}
        kits={kits}
        items={items}
        pickedCategoryIds={pickedCategoryIds}
        setPickedCategoryIds={setPickedCategoryIds}
        pickedKitIds={pickedKitIds}
        setPickedKitIds={setPickedKitIds}
        pickedItemIds={pickedItemIds}
        setPickedItemIds={setPickedItemIds}
      />

      {/* Action row — sticky at the bottom of the viewport so it's always
          visible while the user picks items. Padding-bottom on the parent
          div ensures the sticky bar doesn't cover content. */}
      <div style={{ height: isMobile ? 80 : 96 }} />
      <div style={{
        position: "sticky", bottom: 0, left: 0, right: 0,
        marginTop: 0, padding: isMobile ? "12px 16px" : "16px 0",
        background: C.paper,
        borderTop: `1.5px solid ${C.ink}`,
        boxShadow: `0 -4px 12px rgba(26,36,33,0.06)`,
        display: "flex", gap: 10,
        flexDirection: isMobile ? "column-reverse" : "row",
        justifyContent: "space-between", alignItems: "center", flexWrap: "wrap",
        zIndex: 50,
      }}>
        <Btn variant="ghost" icon={ArrowLeft} onClick={() => setStep(1)} fullWidth={isMobile}>{t("trips.back")}</Btn>
        <Btn onClick={submit} variant="rust" icon={Check} fullWidth={isMobile}>
          {editMode ? t("pl.saveBtn") : t("trips.fileTrip")}
          {(pickedItemIds.length + pickedKitIds.length + pickedCategoryIds.length) > 0 && (
            <span style={{ marginLeft: 8, opacity: 0.85, fontWeight: 500 }}>
              ({pickedItemIds.length + pickedKitIds.length + pickedCategoryIds.length})
            </span>
          )}
        </Btn>
      </div>
    </div>
  );
}

/* ============================================================
   PacklistEditorDialog — full-screen modal for editing a saved
   trip/packlist. Handles BOTH itinerary metadata (name, dates,
   destination, type, notes) AND the unified inventory browser
   (categories, kits, items) in one place. Explicit Save/Cancel.
   Pre-filled with the packlist's current state on open.
   ============================================================ */
function PacklistEditorDialog({
  packlist,
  categories, setCategories,
  kits, setKits,
  items, setItems,
  travelTypes, setTravelTypes,
  onSave, onClose,
}) {
  const { t, locale, lang } = useI18n();
  const { isMobile } = useViewport();

  // Local working copy of all editable fields — only committed on Save.
  const [name, setName] = useState(packlist.name || "");
  const [notes, setNotes] = useState(packlist.notes || "");
  const [dest, setDest] = useState(packlist.dest || "");
  const [type, setType] = useState(packlist.type || "");
  // We store dates as a string on the packlist; if the user enters new dates
  // we re-format. If they don't touch the dates, the existing string is kept.
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [pickedCategoryIds, setPickedCategoryIds] = useState(packlist.categoryIds || []);
  const [pickedKitIds, setPickedKitIds] = useState(packlist.kitIds || []);
  const [pickedItemIds, setPickedItemIds] = useState(packlist.itemIds || []);

  // Inline-create UI state for new items/kits/categories on the fly
  const [inlineMode, setInlineMode] = useState(null); // "item" | "kit" | "cat" | null
  const [newItem, setNewItem] = useState({ name: "", weight: "", category: "" });
  const [newKit, setNewKit] = useState({ name: "", category: "" });
  const [newCat, setNewCat] = useState({ name: "" });

  // Trip-type quick add
  const [addingType, setAddingType] = useState(false);
  const [newType, setNewType] = useState({ name: "" });

  // Section collapse state — itinerary section can fold so the inventory browser gets full screen
  const [itineraryCollapsed, setItineraryCollapsed] = useState(false);

  // Lock body scroll while modal is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const fmt = (d) => {
    if (!d) return "";
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return d;
    return dt.toLocaleDateString(locale, { month: "short", day: "2-digit" });
  };

  // === Inline-create handlers (mirror the wizard) ===
  const saveInlineItem = () => {
    const itemName = newItem.name.trim();
    if (!itemName) return;
    const id = uid("it");
    const created = {
      id, name: itemName,
      category: newItem.category || (categories[0]?.name || "Other"),
      weight: newItem.weight.trim() || "0 g",
      quantity: 1, packed: false, consumable: false,
      expiry: "", remindDays: null,
    };
    setItems([created, ...items]);
    setPickedItemIds((s) => [...s, id]);
    setNewItem({ name: "", weight: "", category: "" });
    setInlineMode(null);
  };
  const saveInlineKit = () => {
    const kitName = newKit.name.trim();
    if (!kitName) return;
    const id = uid("kit");
    const created = { id, name: kitName, category: newKit.category || "", itemIds: [] };
    setKits([created, ...kits]);
    setPickedKitIds((s) => [...s, id]);
    setNewKit({ name: "", category: "" });
    setInlineMode(null);
  };
  const saveInlineCat = () => {
    const catName = newCat.name.trim();
    if (!catName) return;
    const id = uid("cat");
    const created = { id, name: catName, icon: "tag" };
    setCategories([created, ...categories]);
    setPickedCategoryIds((s) => [...s, id]);
    setNewCat({ name: "" });
    setInlineMode(null);
  };
  const saveNewType = () => {
    const tName = newType.name.trim();
    if (!tName) return;
    setTravelTypes([{ id: uid("tt"), icon: "mountain", name: tName, climate: "Variable", days: "1-7" }, ...travelTypes]);
    setType(tName);
    setNewType({ name: "" });
    setAddingType(false);
  };

  const handleSave = () => {
    if (!name.trim()) return;
    let dateString = packlist.date || "";
    if (start && end) dateString = `${fmt(start)} - ${fmt(end)}`;
    else if (start) dateString = fmt(start);

    onSave({
      name: name.trim(),
      notes: notes.trim(),
      dest: dest.trim(),
      date: dateString,
      type: type || "",
      kitIds: pickedKitIds,
      itemIds: pickedItemIds,
      categoryIds: pickedCategoryIds,
    });
  };

  const totalSelected = pickedCategoryIds.length + pickedKitIds.length + pickedItemIds.length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("pl.editFormTitle")}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(26, 36, 33, 0.55)",
        display: "flex", alignItems: "stretch", justifyContent: "center",
        padding: isMobile ? 0 : 24,
      }}
    >
      <div style={{
        width: "100%", maxWidth: 920, background: C.paper,
        display: "flex", flexDirection: "column",
        maxHeight: isMobile ? "100%" : "calc(100vh - 48px)",
        boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
        border: `1.5px solid ${C.ink}`,
      }}>
        {/* Header */}
        <div style={{
          padding: isMobile ? "16px 18px" : "20px 28px",
          background: C.ink, color: C.paper,
          display: "flex", alignItems: "center", gap: 12,
          borderBottom: `2px solid ${C.rust}`,
        }}>
          <Pencil size={18} strokeWidth={1.6} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: "0.2em", textTransform: "uppercase", opacity: 0.7 }}>
              {t("pl.editFormTitle")}
            </div>
            <div style={{ marginTop: 2, fontFamily: F.display, fontSize: isMobile ? 18 : 22, fontWeight: 700, letterSpacing: "-0.02em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {name || packlist.name}
            </div>
          </div>
          <button onClick={onClose}
            style={{ width: 36, height: 36, background: "transparent", border: `1px solid ${C.paper}`, color: C.paper, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
            aria-label={t("common.cancel")}>
            <X size={16} />
          </button>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? "20px 18px" : "28px 28px" }}>
          {/* === SECTION 1: Itinerary (collapsible) === */}
          <div style={{ marginBottom: 28 }}>
            <button
              onClick={() => setItineraryCollapsed(!itineraryCollapsed)}
              style={{
                width: "100%", padding: "10px 0", background: "transparent",
                border: "none", borderBottom: `1.5px solid ${C.ink}`, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "space-between",
                fontFamily: F.display, fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em",
                color: C.ink, textAlign: "left",
              }}
            >
              <span>{t("trips.stepDetailsTitle")}</span>
              <span style={{
                color: itineraryCollapsed ? C.muted : C.forest,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 32, height: 32,
                border: `1.5px solid ${itineraryCollapsed ? C.line : C.forest}`,
                background: itineraryCollapsed ? "transparent" : C.paperDeep,
                flexShrink: 0,
              }}>
                <Menu size={16} strokeWidth={2} />
              </span>
            </button>

            {!itineraryCollapsed && (
              <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: isMobile ? 18 : 22 }}>
                <Field label={t("trips.tripName")} icon={MapPin} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("trips.tripNamePh")} />
                <Field label={t("trips.destination")} icon={Globe} value={dest} onChange={(e) => setDest(e.target.value)} placeholder={t("trips.destinationPh")} />

                {/* Show existing date as a hint if user hasn't picked new ones */}
                {packlist.date && !(start || end) && (
                  <div style={{ padding: 10, background: C.paperDeep, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                    Current dates: {packlist.date}
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: isMobile ? 16 : 20 }}>
                  <Field label={t("trips.startDate")} type="date" icon={Calendar} value={start} onChange={(e) => setStart(e.target.value)} />
                  <Field label={t("trips.endDate")} type="date" icon={Calendar} value={end} onChange={(e) => setEnd(e.target.value)} />
                </div>

                {/* Trip type — custom dropdown */}
                <div>
                  <div style={{ marginBottom: 10, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
                    {t("trips.tripType")}
                  </div>
                  <TripTypeSelect value={type} onChange={(v) => setType(v)} />
                </div>

                {/* Notes */}
                <label style={{ display: "block" }}>
                  <div style={{ marginBottom: 8, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
                    {t("pl.notes")}
                  </div>
                  <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("pl.notesPh")} rows={3}
                    style={{ width: "100%", padding: "10px 0", background: "transparent", border: "none", borderBottom: `1.5px solid ${C.ink}`, outline: "none", fontFamily: F.body, fontSize: 16, color: C.ink, resize: "vertical" }} />
                </label>
              </div>
            )}
          </div>

          {/* === SECTION 2: Pack === */}
          <div>
            <div style={{ marginBottom: 18, padding: "10px 0", borderBottom: `1.5px solid ${C.ink}`, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontFamily: F.display, fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em" }}>{t("trips.stepPackTitle")}</span>
              <span style={{ fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>
                {totalSelected} {totalSelected === 1 ? "pick" : "picks"}
              </span>
            </div>

            {/* Quick add new — moved to TOP of pack section, rust border, big prominent toggles */}
            <div style={{
              marginBottom: 24, padding: isMobile ? 14 : 18,
              background: C.paperDeep,
              border: `2px solid ${C.rust}`,
              boxShadow: `inset 0 0 0 1px ${C.paper}`,
            }}>
              <div style={{
                marginBottom: 12, fontFamily: F.mono, fontSize: 11,
                color: C.rust, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 700,
                display: "flex", alignItems: "center", gap: 8,
              }}>
                <Plus size={14} strokeWidth={2.5} /> {t("trips.unifiedQuickAdd")}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: 8 }}>
                {[
                  ["item", t("trips.addNewItemInline")],
                  ["kit", t("trips.addNewKitInline")],
                  ["cat", t("trips.addNewCatInline")],
                ].map(([k, label]) => {
                  const active = inlineMode === k;
                  return (
                    <button key={k} onClick={() => setInlineMode(active ? null : k)}
                      style={{
                        padding: isMobile ? "12px 14px" : "14px 16px",
                        border: `1.5px solid ${active ? C.rust : C.ink}`,
                        background: active ? C.rust : C.paper,
                        color: active ? C.paper : C.ink,
                        cursor: "pointer",
                        fontFamily: F.mono, fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 700,
                        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                        minHeight: 44,
                      }}>
                      {active ? <X size={14} strokeWidth={2.5} /> : <Plus size={14} strokeWidth={2.5} />}
                      {label.replace(/^\+\s*/, "")}
                    </button>
                  );
                })}
              </div>
              {inlineMode === "item" && (
                <div style={{ marginTop: 14, padding: 14, background: C.paper, border: `1.5px solid ${C.ink}` }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <Field label={t("trips.inlineItemName")} value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} />
                    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12 }}>
                      <Field label={t("trips.inlineItemWeight")} value={newItem.weight} onChange={(e) => setNewItem({ ...newItem, weight: e.target.value })} placeholder="0.5 kg" />
                      <CategorySelect categories={categories} value={newItem.category} onChange={(v) => setNewItem({ ...newItem, category: v })} />
                    </div>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <Btn variant="ghost" icon={X} onClick={() => { setInlineMode(null); setNewItem({ name: "", weight: "", category: "" }); }}>{t("trips.inlineCancel")}</Btn>
                      <Btn variant="rust" icon={Check} onClick={saveInlineItem} disabled={!newItem.name.trim()}>{t("trips.inlineSave")}</Btn>
                    </div>
                  </div>
                </div>
              )}
              {inlineMode === "kit" && (
                <div style={{ marginTop: 14, padding: 14, background: C.paper, border: `1.5px solid ${C.ink}` }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <Field label={t("trips.inlineKitName")} value={newKit.name} onChange={(e) => setNewKit({ ...newKit, name: e.target.value })} />
                    <CategorySelect categories={categories} value={newKit.category} onChange={(v) => setNewKit({ ...newKit, category: v })} />
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <Btn variant="ghost" icon={X} onClick={() => { setInlineMode(null); setNewKit({ name: "", category: "" }); }}>{t("trips.inlineCancel")}</Btn>
                      <Btn variant="rust" icon={Check} onClick={saveInlineKit} disabled={!newKit.name.trim()}>{t("trips.inlineSave")}</Btn>
                    </div>
                  </div>
                </div>
              )}
              {inlineMode === "cat" && (
                <div style={{ marginTop: 14, padding: 14, background: C.paper, border: `1.5px solid ${C.ink}` }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <Field label={t("trips.inlineCatName")} value={newCat.name} onChange={(e) => setNewCat({ name: e.target.value })} />
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <Btn variant="ghost" icon={X} onClick={() => { setInlineMode(null); setNewCat({ name: "" }); }}>{t("trips.inlineCancel")}</Btn>
                      <Btn variant="rust" icon={Check} onClick={saveInlineCat} disabled={!newCat.name.trim()}>{t("trips.inlineSave")}</Btn>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <PacklistPickedSummary
              categories={categories}
              kits={kits}
              items={items}
              pickedCategoryIds={pickedCategoryIds}
              setPickedCategoryIds={setPickedCategoryIds}
              pickedKitIds={pickedKitIds}
              setPickedKitIds={setPickedKitIds}
              pickedItemIds={pickedItemIds}
              setPickedItemIds={setPickedItemIds}
            />
          </div>
        </div>

        {/* Sticky footer with Cancel / Save */}
        <div style={{
          padding: isMobile ? "12px 16px" : "16px 24px",
          borderTop: `1.5px solid ${C.ink}`, background: C.paperDeep,
          display: "flex", gap: 10, justifyContent: "flex-end", flexDirection: isMobile ? "column-reverse" : "row",
        }}>
          <Btn variant="ghost" icon={X} onClick={onClose} fullWidth={isMobile}>{t("common.cancel")}</Btn>
          <Btn variant="rust" icon={Check} onClick={handleSave} disabled={!name.trim()} fullWidth={isMobile}>
            {t("pl.saveBtn")}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   WEATHER GAP DETECTION
   Pulls forecast from Open-Meteo (free, no API key) for a given
   destination + date range, then cross-references against the
   packlist contents to flag missing gear.
   ============================================================ */

// Try to geocode a destination string (e.g. "Iceland", "Patagonia")
// using Open-Meteo's free geocoding endpoint. Returns {lat,lon,name} or null.
async function geocodeDestination(query, lang = "en") {
  if (!query || !query.trim()) return null;
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query.trim())}&count=1&language=${lang}&format=json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const r = data?.results?.[0];
    if (!r) return null;
    return {
      lat: r.latitude,
      lon: r.longitude,
      name: r.name + (r.country ? `, ${r.country}` : ""),
    };
  } catch {
    return null;
  }
}

// Pull a daily forecast from Open-Meteo for the given coordinates and
// date range. Up to 16 days into the future is supported by the API.
async function fetchForecast({ lat, lon, startDate, endDate, units = "metric" }) {
  if (lat == null || lon == null) return null;
  const tempUnit = units === "imperial" ? "fahrenheit" : "celsius";
  const windUnit = units === "imperial" ? "mph" : "kmh";
  const precipUnit = units === "imperial" ? "inch" : "mm";
  let url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,`
    + `windspeed_10m_max,uv_index_max,snowfall_sum&timezone=auto`
    + `&temperature_unit=${tempUnit}&windspeed_unit=${windUnit}&precipitation_unit=${precipUnit}`;
  if (startDate) url += `&start_date=${startDate}`;
  if (endDate)   url += `&end_date=${endDate}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.daily?.time?.length) return null;
    const d = data.daily;
    const safeMin = (arr) => arr.filter((v) => v != null).length ? Math.min(...arr.filter((v) => v != null)) : null;
    const safeMax = (arr) => arr.filter((v) => v != null).length ? Math.max(...arr.filter((v) => v != null)) : null;
    return {
      tempMin: safeMin(d.temperature_2m_min || []),
      tempMax: safeMax(d.temperature_2m_max || []),
      precipMaxMm:    safeMax(d.precipitation_sum || []),
      precipMaxProb:  safeMax(d.precipitation_probability_max || []),
      windMax:        safeMax(d.windspeed_10m_max || []),
      uvMax:          safeMax(d.uv_index_max || []),
      snowMax:        safeMax(d.snowfall_sum || []),
      days: d.time.map((t, i) => ({
        date: t,
        tempMin: d.temperature_2m_min?.[i],
        tempMax: d.temperature_2m_max?.[i],
        precipMm: d.precipitation_sum?.[i],
        precipProb: d.precipitation_probability_max?.[i],
        windMax: d.windspeed_10m_max?.[i],
        snowMm: d.snowfall_sum?.[i],
        uvMax: d.uv_index_max?.[i],
      })),
      tempUnit, windUnit, precipUnit,
    };
  } catch {
    return null;
  }
}

// Knowledge base: which conditions trigger which gear requirements.
// Each requirement has a `keywords` list — if ANY of the user's items has
// that substring (case-insensitive) in name or category, the requirement
// is considered "covered". Otherwise it's flagged as a gap.
function buildRequirements(units) {
  const isMetric = units !== "imperial";
  const T_COLD       = isMetric ? 5 : 41;
  const T_FREEZING   = isMetric ? 0 : 32;
  const T_HOT        = isMetric ? 27 : 80;
  const WIND_HIGH    = isMetric ? 30 : 19;
  const SNOW_ANY     = 1;

  return [
    {
      id: "rain",
      label: "Rain protection",
      detail: (w) => `${w.precipMaxProb || 0}% chance of rain, up to ${(w.precipMaxMm || 0).toFixed(1)}${w.precipUnit}`,
      triggered: (w) => (w.precipMaxProb || 0) >= 40 || (w.precipMaxMm || 0) > 5,
      keywords: ["rain", "waterproof", "hardshell", "hard shell", "poncho", "dry bag", "pack cover"],
    },
    {
      id: "cold",
      label: "Insulation layer",
      detail: (w) => `Temperatures down to ${Math.round(w.tempMin)}°${isMetric ? "C" : "F"}`,
      triggered: (w) => w.tempMin != null && w.tempMin < T_COLD,
      keywords: ["insulation", "down", "puffy", "puffer", "fleece", "thermal", "wool", "merino", "base layer", "long underwear", "vest"],
    },
    {
      id: "freezing",
      label: "Freezing-grade gear",
      detail: (w) => `Temperatures hit ${Math.round(w.tempMin)}°${isMetric ? "C" : "F"}`,
      triggered: (w) => w.tempMin != null && w.tempMin < T_FREEZING,
      keywords: ["sleeping bag", "winter", "subzero", "sub-zero", "balaclava", "beanie", "warm hat", "winter hat", "glove", "mitten"],
    },
    {
      id: "wind",
      label: "Wind protection",
      detail: (w) => `Winds up to ${Math.round(w.windMax)} ${w.windUnit}`,
      triggered: (w) => w.windMax != null && w.windMax >= WIND_HIGH,
      keywords: ["wind", "windproof", "windbreaker", "shell", "hardshell", "softshell"],
    },
    {
      id: "snow",
      label: "Snow gear",
      detail: (w) => `Snowfall expected (${(w.snowMax || 0).toFixed(1)} cm)`,
      triggered: (w) => (w.snowMax || 0) >= SNOW_ANY,
      keywords: ["microspike", "crampon", "gaiter", "snow", "winter boot", "ski"],
    },
    {
      id: "sun",
      label: "Sun protection",
      detail: (w) => `UV index up to ${Math.round(w.uvMax)}`,
      triggered: (w) => w.uvMax != null && w.uvMax >= 6,
      keywords: ["sunscreen", "spf", "sunblock", "sun hat", "brim hat", "sunglasses", "shades", "lip balm"],
    },
    {
      id: "heat",
      label: "Heat / hydration",
      detail: (w) => `Daytime highs up to ${Math.round(w.tempMax)}°${isMetric ? "C" : "F"}`,
      triggered: (w) => w.tempMax != null && w.tempMax >= T_HOT,
      keywords: ["water bottle", "hydration", "bladder", "electrolyte", "salt"],
    },
  ];
}

// Run the analyzer. Returns array of { req, triggered, covered, matchedItems[] }
function analyzePacklistAgainstWeather(items, weather, units) {
  const reqs = buildRequirements(units);
  const haystack = items.map((it) => ({
    item: it,
    text: `${(it.name || "").toLowerCase()} ${(it.category || "").toLowerCase()} ${(it.notes || "").toLowerCase()}`,
  }));
  return reqs.map((req) => {
    const trig = req.triggered(weather);
    if (!trig) return { req, triggered: false, covered: true, matchedItems: [] };
    const matchedItems = haystack
      .filter(({ text }) => req.keywords.some((kw) => text.includes(kw.toLowerCase())))
      .map(({ item }) => item);
    return { req, triggered: true, covered: matchedItems.length > 0, matchedItems };
  });
}

/* ============================================================
   Generate a printable HTML document for a packlist + open the
   browser's print dialog. The user picks "Save as PDF".
   This avoids any external PDF library.
   ============================================================ */
function generatePacklistPDF({ packlist, kits, items, categories, units, lang }) {
  // Hydrate references
  const includedKits       = (packlist.kitIds || []).map((id) => kits.find((k) => k.id === id)).filter(Boolean);
  const includedItems      = (packlist.itemIds || []).map((id) => items.find((i) => i.id === id)).filter(Boolean);
  const includedCategories = (packlist.categoryIds || []).map((id) => categories.find((c) => c.id === id)).filter(Boolean);

  // Compute total weight (unique items only, dedup across kits/items/cats)
  const idsSet = new Set();
  includedKits.forEach((k) => (k.itemIds || []).forEach((iid) => idsSet.add(iid)));
  includedItems.forEach((it) => idsSet.add(it.id));
  includedCategories.forEach((c) => {
    items.forEach((it) => { if (it.category === c.name) idsSet.add(it.id); });
  });
  const allUnique = Array.from(idsSet).map((id) => items.find((i) => i.id === id)).filter(Boolean);
  const totalKg = allUnique.reduce((s, i) => s + parseKg(i.weight || ""), 0);
  const totalWeightStr = formatWeightFromKg(totalKg, units);

  // Tiny HTML escape (user-supplied strings are notes, names, etc.)
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

  const isSpanish = lang === "es";

  // Per-trip want/packed sets — pre-filled red ticks for wanted items.
  // BACKWARDS COMPAT: legacy packlists default to "everything is wanted".
  const wantedSet = new Set(packlist.wantedItemIds || null);
  const hasWantedOverride = Array.isArray(packlist.wantedItemIds);
  const packedSet = new Set(packlist.packedItemIds || []);
  const isWanted = (id) => hasWantedOverride ? wantedSet.has(id) : true;
  const isPacked = (id) => packedSet.has(id);

  // Item-row helper: renders the same way for items inside kits and standalone items.
  // Includes two boxes: WANT (red, ticked when wanted) and PACKED (green, blank for user to fill).
  const itemRow = (it) => {
    if (!it) return "";
    const wantBox = isWanted(it.id)
      ? `<span class="cb cb-want cb-checked">✓</span>`
      : `<span class="cb cb-want"></span>`;
    const packBox = isPacked(it.id)
      ? `<span class="cb cb-packed cb-checked">✓</span>`
      : `<span class="cb cb-packed"></span>`;
    return `
      <tr>
        <td class="cell-cb">${wantBox}</td>
        <td class="cell-cb">${packBox}</td>
        <td class="cell-name">${esc(it.name)}</td>
        <td class="cell-cat">${esc(it.category || "—")}</td>
        <td class="cell-w">${esc(it.weight || "—")}</td>
      </tr>`;
  };

  // Build the kits section
  const kitsHTML = includedKits.length === 0 ? "" : `
    <h2 class="section-title">${isSpanish ? "Kits" : "Kits"} <span class="count">${includedKits.length}</span></h2>
    ${includedKits.map((k) => {
      const kitItems = (k.itemIds || []).map((iid) => items.find((i) => i.id === iid)).filter(Boolean);
      const kitWeightKg = kitItems.reduce((s, i) => s + parseKg(i.weight || ""), 0);
      const kitWeightStr = formatWeightFromKg(kitWeightKg, units);
      return `
        <div class="kit-block">
          <div class="kit-header">
            <span class="kit-name">${esc(k.name)}</span>
            <span class="kit-meta">${esc(k.category || "")} · ${kitItems.length} ${isSpanish ? (kitItems.length === 1 ? "artículo" : "artículos") : (kitItems.length === 1 ? "item" : "items")} · ${esc(kitWeightStr)}</span>
          </div>
          ${kitItems.length === 0 ? `<div class="empty">${isSpanish ? "Sin artículos." : "No items."}</div>` : `
            <table class="items-table">
              <thead>
                <tr>
                  <th class="cell-cb">${isSpanish ? "Llev" : "Want"}</th>
                  <th class="cell-cb">${isSpanish ? "Emp" : "Pkd"}</th>
                  <th>${isSpanish ? "Artículo" : "Item"}</th>
                  <th>${isSpanish ? "Categoría" : "Category"}</th>
                  <th>${isSpanish ? "Peso" : "Weight"}</th>
                </tr>
              </thead>
              <tbody>${kitItems.map(itemRow).join("")}</tbody>
            </table>
          `}
        </div>`;
    }).join("")}`;

  // Build the standalone-items section
  const itemsHTML = includedItems.length === 0 ? "" : `
    <h2 class="section-title">${isSpanish ? "Artículos individuales" : "Individual items"} <span class="count">${includedItems.length}</span></h2>
    <table class="items-table">
      <thead>
        <tr>
          <th class="cell-cb">${isSpanish ? "Llev" : "Want"}</th>
          <th class="cell-cb">${isSpanish ? "Emp" : "Pkd"}</th>
          <th>${isSpanish ? "Artículo" : "Item"}</th>
          <th>${isSpanish ? "Categoría" : "Category"}</th>
          <th>${isSpanish ? "Peso" : "Weight"}</th>
        </tr>
      </thead>
      <tbody>${includedItems.map(itemRow).join("")}</tbody>
    </table>`;

  // Build the categories section (live-linked)
  const catsHTML = includedCategories.length === 0 ? "" : `
    <h2 class="section-title">${isSpanish ? "Categorías" : "Categories"} <span class="count">${includedCategories.length}</span></h2>
    ${includedCategories.map((c) => {
      const catItems = items.filter((i) => i.category === c.name);
      return `
        <div class="kit-block">
          <div class="kit-header">
            <span class="kit-name">${esc(c.name)}</span>
            <span class="kit-meta">${catItems.length} ${isSpanish ? (catItems.length === 1 ? "artículo" : "artículos") : (catItems.length === 1 ? "item" : "items")}</span>
          </div>
          ${catItems.length === 0 ? `<div class="empty">${isSpanish ? "Sin artículos en esta categoría." : "No items in this category."}</div>` : `
            <table class="items-table">
              <thead>
                <tr>
                  <th class="cell-cb">${isSpanish ? "Llev" : "Want"}</th>
                  <th class="cell-cb">${isSpanish ? "Emp" : "Pkd"}</th>
                  <th>${isSpanish ? "Artículo" : "Item"}</th>
                  <th>${isSpanish ? "Categoría" : "Category"}</th>
                  <th>${isSpanish ? "Peso" : "Weight"}</th>
                </tr>
              </thead>
              <tbody>${catItems.map(itemRow).join("")}</tbody>
            </table>
          `}
        </div>`;
    }).join("")}`;

  // Field journal styled HTML
  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<title>${esc(packlist.name || "Packlist")} — PakMondo</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: Georgia, "Times New Roman", serif;
    color: #1A2421;
    background: #EFE7D6;
    margin: 0; padding: 24px 28px;
    line-height: 1.5;
  }
  .header {
    border-bottom: 2px solid #1A2421;
    padding-bottom: 14px;
    margin-bottom: 24px;
  }
  .brand-strip {
    font-family: ui-monospace, "SF Mono", monospace;
    font-size: 10px; color: #8B7E6B;
    letter-spacing: 0.2em; text-transform: uppercase;
    margin-bottom: 8px;
  }
  h1 {
    font-size: 32px; font-weight: 700;
    letter-spacing: -0.02em; line-height: 1.05;
    margin: 0 0 4px 0;
  }
  h1 .dot { color: #B8451F; }
  .meta {
    margin-top: 10px;
    font-family: ui-monospace, "SF Mono", monospace;
    font-size: 11px; color: #8B7E6B;
    letter-spacing: 0.12em; text-transform: uppercase;
    line-height: 1.6;
  }
  .meta-row { margin-bottom: 2px; }
  .notes {
    margin-top: 12px;
    font-style: italic; color: #4A5550;
    font-size: 14px;
  }
  .totals {
    margin-top: 16px; padding: 10px 14px;
    background: #1A2421; color: #EFE7D6;
    font-family: ui-monospace, "SF Mono", monospace;
    font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
    font-weight: 700;
  }
  h2.section-title {
    font-size: 22px; font-weight: 700;
    letter-spacing: -0.01em;
    margin: 28px 0 12px 0;
    padding-bottom: 4px;
    border-bottom: 1px dashed #C9BBA0;
  }
  h2 .count {
    font-family: ui-monospace, "SF Mono", monospace;
    font-size: 11px; color: #8B7E6B;
    letter-spacing: 0.18em; text-transform: uppercase;
    font-weight: 500; margin-left: 10px;
  }
  .kit-block {
    margin-bottom: 16px;
    border: 1.5px solid #1A2421;
    background: #FFFFFF;
    page-break-inside: avoid;
  }
  .kit-header {
    padding: 8px 14px;
    background: #2D4A3E; color: #EFE7D6;
    display: flex; justify-content: space-between; align-items: baseline;
    flex-wrap: wrap; gap: 8px;
  }
  .kit-name { font-size: 16px; font-weight: 700; }
  .kit-meta {
    font-family: ui-monospace, "SF Mono", monospace;
    font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase;
    opacity: 0.85;
  }
  .empty {
    padding: 12px 14px;
    font-style: italic; color: #8B7E6B;
    font-size: 13px;
  }
  table.items-table {
    width: 100%;
    border-collapse: collapse;
    background: #FFFFFF;
  }
  table.items-table th, table.items-table td {
    text-align: left;
    padding: 8px 14px;
    border-bottom: 1px solid #E5DAC2;
    font-size: 13px;
  }
  table.items-table th {
    font-family: ui-monospace, "SF Mono", monospace;
    font-size: 10px; color: #8B7E6B;
    letter-spacing: 0.15em; text-transform: uppercase;
    font-weight: 700;
    background: #F5EEE0;
  }
  .cell-name { font-weight: 500; color: #1A2421; }
  .cell-cat { color: #4A5550; font-style: italic; }
  .cell-w { color: #4A5550; white-space: nowrap; }
  .cell-cb { width: 26px; padding: 4px 4px 4px 0; }
  /* Two checkboxes per item: red WANT (pre-filled), green PACKED (blank).
     Boxes render as small bordered squares; ticked ones get a colored fill. */
  .cb {
    display: inline-block;
    width: 16px; height: 16px;
    border: 2px solid #1A2421;
    text-align: center; line-height: 13px;
    font-weight: 700; font-size: 13px;
    vertical-align: middle;
  }
  .cb-want   { border-color: #B8451F; color: #B8451F; }
  .cb-packed { border-color: #3F8B5C; color: #3F8B5C; }
  .cb-want.cb-checked   { background: #B8451F; color: #FFFFFF; }
  .cb-packed.cb-checked { background: #3F8B5C; color: #FFFFFF; }
  .footer {
    margin-top: 36px; padding-top: 14px;
    border-top: 1px dashed #C9BBA0;
    font-family: ui-monospace, "SF Mono", monospace;
    font-size: 10px; color: #8B7E6B;
    letter-spacing: 0.15em; text-transform: uppercase;
    display: flex; justify-content: space-between;
    flex-wrap: wrap; gap: 10px;
  }
  .footer em {
    font-family: Georgia, serif; font-style: italic;
    text-transform: none; letter-spacing: normal;
  }
  @media print {
    body { background: #FFFFFF; padding: 0; }
    .no-print { display: none !important; }
  }
</style>
</head>
<body>
  <div class="header">
    <div class="brand-strip">PAKMONDO · ${isSpanish ? "LISTA DE EQUIPAJE" : "FIELD PACKLIST"}</div>
    <h1>${esc(packlist.name || (isSpanish ? "Lista" : "Packlist"))}<span class="dot">.</span></h1>
    <div class="meta">
      ${packlist.dest ? `<div class="meta-row">📍 ${esc(packlist.dest)}</div>` : ""}
      ${packlist.date ? `<div class="meta-row">📅 ${esc(packlist.date)}</div>` : ""}
      ${packlist.type ? `<div class="meta-row">⚑ ${esc(packlist.type)}</div>` : ""}
    </div>
    ${packlist.notes ? `<div class="notes">"${esc(packlist.notes)}"</div>` : ""}
    <div class="totals">${isSpanish ? "Total" : "Total"}: ${allUnique.length} ${isSpanish ? (allUnique.length === 1 ? "artículo" : "artículos") : (allUnique.length === 1 ? "item" : "items")}${totalKg > 0 ? ` · ${esc(totalWeightStr)}` : ""}</div>
  </div>

  ${kitsHTML}
  ${itemsHTML}
  ${catsHTML}

  ${(includedKits.length === 0 && includedItems.length === 0 && includedCategories.length === 0) ?
    `<div class="empty" style="text-align:center; padding: 40px;">${isSpanish ? "Esta lista está vacía." : "This packlist is empty."}</div>` : ""}

  <div class="footer">
    <span><em>Be Prepared, Be Anywhere.</em> · pakmondo.com</span>
    <span>${new Date().toLocaleDateString(lang === "es" ? "es-ES" : "en-US", { year: "numeric", month: "short", day: "numeric" })}</span>
  </div>

  <script>
    // Auto-trigger the print dialog once the page loads.
    window.addEventListener("load", () => {
      // Tiny delay so styles paint first
      setTimeout(() => { window.print(); }, 250);
    });
  </script>
</body>
</html>`;

  // Open the document in a new window. Browser blocks popups unless this
  // is called from a user-initiated event (which it is — button click).
  const win = window.open("", "_blank");
  if (!win) {
    alert(isSpanish
      ? "Tu navegador bloqueó la ventana emergente. Permítela e inténtalo de nuevo."
      : "Your browser blocked the popup. Allow it and try again.");
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
}

/* ============================================================
   KitDetailModal — shows the items in a kit, lets the user:
     • Tap an item to edit it
     • Click X next to an item to UNLINK it from the kit
       (item still exists in inventory, just not in this kit)
     • Tick existing items from inventory to ADD to the kit
     • Create a brand-new item which gets added to the kit
   Used from PacklistDetail when the user taps a kit card.
   ============================================================ */
function KitDetailModal({ kit, items, categories, onUpdateKit, onUpdateItem, onAddItem, onClose, onEditItem }) {
  const { t, lang, units } = useI18n();
  const { isMobile } = useViewport();
  const [showCreate, setShowCreate] = useState(false);
  const [showAddExisting, setShowAddExisting] = useState(false);
  const [newItem, setNewItem] = useState({ name: "", weight: "", category: "" });

  // Items currently in the kit
  const kitItems = (kit.itemIds || []).map((id) => items.find((i) => i.id === id)).filter(Boolean);
  // Items in inventory NOT currently in the kit — candidates for "add"
  const otherItems = items.filter((it) => !(kit.itemIds || []).includes(it.id));
  // Total weight summary
  const kitKg = kitItems.reduce((s, i) => s + parseKg(i.weight || ""), 0);
  const kitWeightStr = formatWeightFromKg(kitKg, units);

  // Unlink an item from the kit (item itself is preserved)
  const removeFromKit = (itemId) => {
    onUpdateKit({ ...kit, itemIds: (kit.itemIds || []).filter((x) => x !== itemId) });
  };
  // Toggle "add existing" — flips an item's membership in the kit
  const toggleExisting = (itemId) => {
    const isIn = (kit.itemIds || []).includes(itemId);
    onUpdateKit({
      ...kit,
      itemIds: isIn
        ? kit.itemIds.filter((x) => x !== itemId)
        : [...(kit.itemIds || []), itemId],
    });
  };
  // Create a new item and add it to the kit in one go
  const saveNewItem = () => {
    if (!newItem.name.trim()) return;
    const created = {
      id: uid("it"),
      name: newItem.name.trim(),
      weight: newItem.weight.trim() || null,
      category: newItem.category || null,
      packed: false,
    };
    onAddItem(created);
    onUpdateKit({ ...kit, itemIds: [...(kit.itemIds || []), created.id] });
    setNewItem({ name: "", weight: "", category: "" });
    setShowCreate(false);
  };

  return (
    <Modal title={kit.name} onClose={onClose}>
      <div style={{ padding: isMobile ? 16 : 24, overflowY: "auto" }}>
        {/* Header strip */}
        <div style={{ marginBottom: 16, paddingBottom: 12, borderBottom: `1.5px solid ${C.line}` }}>
          <Coord>KIT</Coord>
          <div style={{ marginTop: 4, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>
            {kitItems.length} {kitItems.length === 1 ? "item" : "items"} · {kitWeightStr}
          </div>
        </div>

        {/* === ITEMS IN THIS KIT === */}
        <div style={{ marginBottom: 18, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
          {t("kitDetail.itemsInKit")}
        </div>
        {kitItems.length === 0 ? (
          <div style={{ padding: "12px 0", marginBottom: 18, fontFamily: F.body, fontStyle: "italic", color: C.inkSoft, fontSize: 13 }}>
            {t("kitDetail.empty")}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 18 }}>
            {kitItems.map((it) => (
              <div key={it.id}
                onClick={() => onEditItem && onEditItem(it.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                  background: C.paper, border: `1px solid ${C.line}`,
                  cursor: onEditItem ? "pointer" : "default",
                }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: F.body, fontSize: 14, fontWeight: 500, color: C.ink }}>{it.name}</div>
                  <div style={{ marginTop: 2, fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                    {it.category || t("trips.unifiedNoCategory")}{it.weight ? ` · ${formatWeight(it.weight, units)}` : ""}
                  </div>
                </div>
                <button onClick={(e) => { e.stopPropagation(); removeFromKit(it.id); }}
                  style={{ width: 28, height: 28, padding: 0, background: "transparent", border: `1px solid ${C.muted}`, color: C.muted, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                  title={t("kitDetail.unlinkItem")}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.rust; e.currentTarget.style.color = C.rust; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.muted; e.currentTarget.style.color = C.muted; }}>
                  <X size={13} strokeWidth={2.5} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* === ADD EXISTING ITEMS === */}
        {!showAddExisting ? (
          <button onClick={() => setShowAddExisting(true)}
            style={{
              width: "100%", padding: "12px 14px", marginBottom: 8,
              background: "transparent", border: `1.5px solid ${C.ink}`, color: C.ink,
              cursor: "pointer", fontFamily: F.mono, fontSize: 11,
              letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700,
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}>
            <Plus size={14} strokeWidth={2.5} /> {t("kitDetail.addExisting")} ({otherItems.length})
          </button>
        ) : (
          <div style={{ marginBottom: 10, padding: 12, background: C.paperDeep, border: `1.5px solid ${C.ink}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
                {t("kitDetail.tickToAdd")}
              </span>
              <button onClick={() => setShowAddExisting(false)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", padding: 4 }} aria-label="Close">
                <X size={14} />
              </button>
            </div>
            {otherItems.length === 0 ? (
              <div style={{ padding: "10px 0", fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.inkSoft }}>
                {t("kitDetail.noOthersToAdd")}
              </div>
            ) : (
              <div style={{ maxHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                {otherItems.map((it) => (
                  <button key={it.id}
                    onClick={() => toggleExisting(it.id)}
                    style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                      background: "transparent",
                      border: `1px solid ${C.line}`,
                      cursor: "pointer", textAlign: "left",
                    }}>
                    <span style={{ width: 18, height: 18, flexShrink: 0, border: `1.5px solid ${C.muted}`, background: "transparent" }}></span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: F.body, fontSize: 14, fontWeight: 500, color: C.ink }}>{it.name}</div>
                      <div style={{ marginTop: 1, fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                        {it.category || t("trips.unifiedNoCategory")}{it.weight ? ` · ${formatWeight(it.weight, units)}` : ""}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* === CREATE NEW ITEM === */}
        {!showCreate ? (
          <button onClick={() => setShowCreate(true)}
            style={{
              width: "100%", padding: "12px 14px",
              background: "transparent", border: `1.5px dashed ${C.rust}`, color: C.rust,
              cursor: "pointer", fontFamily: F.mono, fontSize: 11,
              letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700,
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}>
            <Plus size={14} strokeWidth={2.5} /> {t("kitDetail.createNew")}
          </button>
        ) : (
          <div style={{ padding: 12, background: C.paper, border: `1.5px dashed ${C.rust}` }}>
            <div style={{ marginBottom: 10, fontFamily: F.mono, fontSize: 10, color: C.rust, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
              + {t("kitDetail.createNew")}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Field label={t("trips.inlineItemName")} value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} />
              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12 }}>
                <Field label={t("trips.inlineItemWeight")} value={newItem.weight} onChange={(e) => setNewItem({ ...newItem, weight: e.target.value })} placeholder="0.5 kg" />
                <CategorySelect categories={categories} value={newItem.category} onChange={(v) => setNewItem({ ...newItem, category: v })} />
              </div>
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <Btn variant="ghost" icon={X} onClick={() => { setShowCreate(false); setNewItem({ name: "", weight: "", category: "" }); }}>{t("trips.inlineCancel")}</Btn>
                <Btn variant="rust" icon={Check} onClick={saveNewItem} disabled={!newItem.name.trim()}>{t("trips.inlineSave")}</Btn>
              </div>
            </div>
          </div>
        )}

        <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end" }}>
          <Btn variant="ghost" icon={Check} onClick={onClose} fullWidth={isMobile}>{t("common.done")}</Btn>
        </div>
      </div>
    </Modal>
  );
}

/* ============================================================
   CategoryDetailModal — shows items in this category, lets the
   user add/remove items via item.category field assignment.
   Same shape as KitDetailModal but operates on the category
   field of items rather than a kit's itemIds list.
   ============================================================ */
function CategoryDetailModal({ category, items, kits, categories, onUpdateItem, onAddItem, onClose, onEditItem, onEditKit }) {
  const { t, lang, units } = useI18n();
  const { isMobile } = useViewport();
  const [showCreate, setShowCreate] = useState(false);
  const [showAddExisting, setShowAddExisting] = useState(false);
  const [newItem, setNewItem] = useState({ name: "", weight: "" });

  // Items currently in this category
  const inCategory = items.filter((i) => i.category === category.name);
  const otherItems = items.filter((i) => i.category !== category.name);

  // Group items by kit. Each item only counts once even if (theoretically)
  // it ends up in multiple kits — first match wins.
  // - kitGroups: array of { kit, items[] } — only kits that have at least
  //   one item belonging to this category
  // - looseItems: items in this category that aren't in any kit
  const kitGroups = [];
  const looseItems = [];
  if (kits && kits.length > 0) {
    const itemIdToKit = new Map();
    kits.forEach((k) => {
      (k.itemIds || []).forEach((id) => {
        if (!itemIdToKit.has(id)) itemIdToKit.set(id, k.id);
      });
    });
    const groupByKit = new Map(); // kitId -> [items]
    inCategory.forEach((it) => {
      const kid = itemIdToKit.get(it.id);
      if (kid) {
        if (!groupByKit.has(kid)) groupByKit.set(kid, []);
        groupByKit.get(kid).push(it);
      } else {
        looseItems.push(it);
      }
    });
    groupByKit.forEach((arr, kid) => {
      const k = kits.find((x) => x.id === kid);
      if (k) kitGroups.push({ kit: k, items: arr });
    });
    // Sort kits alphabetically for predictable rendering
    kitGroups.sort((a, b) => a.kit.name.localeCompare(b.kit.name));
  } else {
    // No kits at all — everything is loose
    looseItems.push(...inCategory);
  }

  // Unset an item's category (item still exists, just unlinked from this category)
  const removeFromCategory = (itemId) => {
    onUpdateItem(itemId, { category: null });
  };
  // Move an existing item into this category
  const addExisting = (itemId) => {
    onUpdateItem(itemId, { category: category.name });
  };
  // Create a new item in this category
  const saveNewItem = () => {
    if (!newItem.name.trim()) return;
    onAddItem({
      id: uid("it"),
      name: newItem.name.trim(),
      weight: newItem.weight.trim() || null,
      category: category.name,
      packed: false,
    });
    setNewItem({ name: "", weight: "" });
    setShowCreate(false);
  };

  return (
    <Modal title={category.name} onClose={onClose}>
      <div style={{ padding: isMobile ? 16 : 24, overflowY: "auto" }}>
        <div style={{ marginBottom: 16, paddingBottom: 12, borderBottom: `1.5px solid ${C.line}` }}>
          <Coord>CATEGORY</Coord>
          <div style={{ marginTop: 4, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>
            {inCategory.length} {inCategory.length === 1 ? "item" : "items"}
          </div>
        </div>

        <div style={{ marginBottom: 18, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
          {t("catDetail.itemsInCategory")}
        </div>
        {inCategory.length === 0 ? (
          <div style={{ padding: "12px 0", marginBottom: 18, fontFamily: F.body, fontStyle: "italic", color: C.inkSoft, fontSize: 13 }}>
            {t("catDetail.empty")}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 18, marginBottom: 18 }}>
            {/* === KIT GROUPS — items that belong to a kit === */}
            {kitGroups.map(({ kit, items: kitItems }) => (
              <div key={kit.id}>
                {/* Kit header — tap to drill into the kit's own modal */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, paddingBottom: 6, borderBottom: `1.5px solid ${C.ink}` }}>
                  <button
                    onClick={() => onEditKit && onEditKit(kit.id)}
                    style={{
                      flex: 1, minWidth: 0, textAlign: "left",
                      background: "none", border: "none", padding: 0, cursor: onEditKit ? "pointer" : "default",
                    }}>
                    <div style={{ fontFamily: F.display, fontSize: 16, fontWeight: 700, letterSpacing: "-0.01em", color: C.ink }}>
                      {kit.name}
                    </div>
                    <div style={{ marginTop: 2, fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                      KIT · {kitItems.length} {kitItems.length === 1 ? "item" : "items"}
                    </div>
                  </button>
                </div>
                {/* Items inside this kit */}
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {kitItems.map((it) => (
                    <div key={it.id}
                      onClick={() => onEditItem && onEditItem(it.id)}
                      style={{
                        display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                        borderBottom: `1px solid ${C.line}`,
                        cursor: onEditItem ? "pointer" : "default",
                      }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: F.body, fontSize: 14, fontWeight: 500, color: C.ink }}>{it.name}</div>
                        {it.weight && (
                          <div style={{ marginTop: 2, fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                            {formatWeight(it.weight, units)}
                          </div>
                        )}
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); removeFromCategory(it.id); }}
                        style={{ width: 28, height: 28, padding: 0, background: "transparent", border: `1px solid ${C.muted}`, color: C.muted, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                        title={t("catDetail.unlinkItem")}
                        onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.rust; e.currentTarget.style.color = C.rust; }}
                        onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.muted; e.currentTarget.style.color = C.muted; }}>
                        <X size={13} strokeWidth={2.5} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {/* === LOOSE ITEMS — in this category but not in any kit === */}
            {looseItems.length > 0 && (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, paddingBottom: 6, borderBottom: `1.5px solid ${C.ink}` }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: F.display, fontSize: 16, fontWeight: 700, letterSpacing: "-0.01em", color: C.ink, fontStyle: "italic" }}>
                      {t("catDetail.looseItems")}
                    </div>
                    <div style={{ marginTop: 2, fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                      {looseItems.length} {looseItems.length === 1 ? "item" : "items"} · {t("catDetail.notInKit")}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {looseItems.map((it) => (
                    <div key={it.id}
                      onClick={() => onEditItem && onEditItem(it.id)}
                      style={{
                        display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                        borderBottom: `1px solid ${C.line}`,
                        cursor: onEditItem ? "pointer" : "default",
                      }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: F.body, fontSize: 14, fontWeight: 500, color: C.ink }}>{it.name}</div>
                        {it.weight && (
                          <div style={{ marginTop: 2, fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                            {formatWeight(it.weight, units)}
                          </div>
                        )}
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); removeFromCategory(it.id); }}
                        style={{ width: 28, height: 28, padding: 0, background: "transparent", border: `1px solid ${C.muted}`, color: C.muted, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                        title={t("catDetail.unlinkItem")}
                        onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.rust; e.currentTarget.style.color = C.rust; }}
                        onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.muted; e.currentTarget.style.color = C.muted; }}>
                        <X size={13} strokeWidth={2.5} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Add existing items */}
        {!showAddExisting ? (
          <button onClick={() => setShowAddExisting(true)}
            style={{
              width: "100%", padding: "12px 14px", marginBottom: 8,
              background: "transparent", border: `1.5px solid ${C.ink}`, color: C.ink,
              cursor: "pointer", fontFamily: F.mono, fontSize: 11,
              letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700,
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}>
            <Plus size={14} strokeWidth={2.5} /> {t("catDetail.addExisting")} ({otherItems.length})
          </button>
        ) : (
          <div style={{ marginBottom: 10, padding: 12, background: C.paperDeep, border: `1.5px solid ${C.ink}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
                {t("catDetail.tickToAdd")}
              </span>
              <button onClick={() => setShowAddExisting(false)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", padding: 4 }} aria-label="Close">
                <X size={14} />
              </button>
            </div>
            {otherItems.length === 0 ? (
              <div style={{ padding: "10px 0", fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.inkSoft }}>
                {t("catDetail.noOthersToAdd")}
              </div>
            ) : (
              <div style={{ maxHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                {otherItems.map((it) => (
                  <button key={it.id}
                    onClick={() => addExisting(it.id)}
                    style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                      background: "transparent", border: `1px solid ${C.line}`,
                      cursor: "pointer", textAlign: "left",
                    }}>
                    <span style={{ width: 18, height: 18, flexShrink: 0, border: `1.5px solid ${C.muted}`, background: "transparent" }}></span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: F.body, fontSize: 14, fontWeight: 500, color: C.ink }}>{it.name}</div>
                      <div style={{ marginTop: 1, fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                        {it.category || t("trips.unifiedNoCategory")}{it.weight ? ` · ${formatWeight(it.weight, units)}` : ""}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Create new item in this category */}
        {!showCreate ? (
          <button onClick={() => setShowCreate(true)}
            style={{
              width: "100%", padding: "12px 14px",
              background: "transparent", border: `1.5px dashed ${C.rust}`, color: C.rust,
              cursor: "pointer", fontFamily: F.mono, fontSize: 11,
              letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700,
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}>
            <Plus size={14} strokeWidth={2.5} /> {t("catDetail.createNew")}
          </button>
        ) : (
          <div style={{ padding: 12, background: C.paper, border: `1.5px dashed ${C.rust}` }}>
            <div style={{ marginBottom: 10, fontFamily: F.mono, fontSize: 10, color: C.rust, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
              + {t("catDetail.createNew")}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Field label={t("trips.inlineItemName")} value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} />
              <Field label={t("trips.inlineItemWeight")} value={newItem.weight} onChange={(e) => setNewItem({ ...newItem, weight: e.target.value })} placeholder="0.5 kg" />
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <Btn variant="ghost" icon={X} onClick={() => { setShowCreate(false); setNewItem({ name: "", weight: "" }); }}>{t("trips.inlineCancel")}</Btn>
                <Btn variant="rust" icon={Check} onClick={saveNewItem} disabled={!newItem.name.trim()}>{t("trips.inlineSave")}</Btn>
              </div>
            </div>
          </div>
        )}

        <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end" }}>
          <Btn variant="ghost" icon={Check} onClick={onClose} fullWidth={isMobile}>{t("common.done")}</Btn>
        </div>
      </div>
    </Modal>
  );
}

/* ============================================================
   ItemDetailModal — read-only item view with Edit and Delete
   buttons. Tap Edit to open the full item edit modal; Delete
   removes the item from inventory entirely (with confirmation).
   ============================================================ */
function ItemDetailModal({ item, onClose, onEdit, onDelete }) {
  const { t, units } = useI18n();
  const { isMobile } = useViewport();
  const [confirming, setConfirming] = useState(false);

  return (
    <Modal title={item.name} onClose={onClose}>
      <div style={{ padding: isMobile ? 16 : 24, overflowY: "auto" }}>
        <div style={{ marginBottom: 16, paddingBottom: 12, borderBottom: `1.5px solid ${C.line}` }}>
          <Coord>ITEM</Coord>
          <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
            {item.name}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
          <DetailRow label={t("itemDetail.category")} value={item.category || "—"} />
          <DetailRow label={t("itemDetail.weight")}   value={item.weight ? formatWeight(item.weight, units) : "—"} />
          {item.quantity > 1 && <DetailRow label={t("itemDetail.quantity")} value={String(item.quantity)} />}
          {item.size                && <DetailRow label={t("itemDetail.size")}     value={item.size} />}
          {item.consumable           && <DetailRow label={t("itemDetail.consumable")} value={t("common.yes")} />}
          {item.expiry              && <DetailRow label={t("itemDetail.expiry")}   value={item.expiry} />}
          {item.notes               && <DetailRow label={t("itemDetail.notes")}    value={item.notes} />}
        </div>

        {confirming ? (
          <div style={{ marginBottom: 14, padding: 14, background: C.paperDeep, border: `1.5px dashed ${C.rust}` }}>
            <div style={{ fontFamily: F.body, fontSize: 14, color: C.inkSoft, marginBottom: 12 }}>
              {t("itemDetail.confirmDelete")}
            </div>
            <div style={{ display: "flex", gap: 8, flexDirection: isMobile ? "column-reverse" : "row", justifyContent: "flex-end" }}>
              <Btn variant="ghost" icon={X} onClick={() => setConfirming(false)} fullWidth={isMobile}>{t("common.cancel")}</Btn>
              <Btn variant="rust" icon={Trash2} onClick={() => { onDelete(); onClose(); }} fullWidth={isMobile}>{t("pl.confirmYes")}</Btn>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexDirection: isMobile ? "column-reverse" : "row" }}>
            <Btn variant="ghost" icon={Trash2} onClick={() => setConfirming(true)} fullWidth={isMobile}>{t("itemDetail.delete")}</Btn>
            <Btn variant="rust" icon={Pencil} onClick={onEdit} fullWidth={isMobile}>{t("itemDetail.edit")}</Btn>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* Tiny labelled detail row used inside ItemDetailModal */
function DetailRow({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: `1px solid ${C.line}` }}>
      <span style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700 }}>{label}</span>
      <span style={{ fontFamily: F.body, fontSize: 14, color: C.ink, textAlign: "right", maxWidth: "70%" }}>{value}</span>
    </div>
  );
}

/* ============================================================
   WeatherCheckModal — runs gap detection for a packlist:
   1) Resolve coords from packlist.coords or geocode packlist.dest
   2) Fetch forecast for date range
   3) Cross-check items vs requirements
   4) Show summary + gaps
   ============================================================ */
function WeatherCheckModal({ packlist, items, kits, categories, onClose }) {
  const { t, lang, units } = useI18n();
  const { isMobile } = useViewport();
  const [stage, setStage] = useState("loading"); // "loading" | "needsLocation" | "ready" | "error"
  const [weather, setWeather] = useState(null);
  const [analysis, setAnalysis] = useState([]);
  const [resolvedLocation, setResolvedLocation] = useState(null);
  const [error, setError] = useState("");

  // Resolve included items (from kits, standalone, and category-linked)
  const allUniqueItems = (() => {
    const idsSet = new Set();
    (packlist.kitIds || []).forEach((kid) => {
      const kit = kits.find((k) => k.id === kid);
      if (kit) (kit.itemIds || []).forEach((iid) => idsSet.add(iid));
    });
    (packlist.itemIds || []).forEach((iid) => idsSet.add(iid));
    (packlist.categoryIds || []).forEach((cid) => {
      const cat = categories.find((c) => c.id === cid);
      if (cat) items.forEach((it) => { if (it.category === cat.name) idsSet.add(it.id); });
    });
    return Array.from(idsSet).map((id) => items.find((i) => i.id === id)).filter(Boolean);
  })();

  // Parse date range from packlist.date — accept ISO strings, ranges, or single dates
  const parseDateRange = () => {
    const raw = packlist.date || "";
    // Try to find ISO dates (YYYY-MM-DD) inside the string
    const matches = raw.match(/\d{4}-\d{2}-\d{2}/g) || [];
    if (matches.length >= 2) return { startDate: matches[0], endDate: matches[1] };
    if (matches.length === 1) {
      const d = matches[0];
      // Default to a 1-day forecast
      return { startDate: d, endDate: d };
    }
    // No usable date — use today + 7 days as a sensible default
    const today = new Date();
    const week  = new Date(today.getTime() + 7 * 86400000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    return { startDate: fmt(today), endDate: fmt(week) };
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Step 1: get coordinates
        let lat = packlist.coords?.lat;
        let lon = packlist.coords?.lon;
        let placeName = packlist.dest;

        if (lat == null || lon == null) {
          // Try to geocode the destination
          if (!packlist.dest || !packlist.dest.trim()) {
            if (!cancelled) setStage("needsLocation");
            return;
          }
          const geo = await geocodeDestination(packlist.dest, lang);
          if (!geo) {
            if (!cancelled) {
              setError(t("weather.geocodeFailed"));
              setStage("error");
            }
            return;
          }
          lat = geo.lat; lon = geo.lon; placeName = geo.name;
        }

        if (!cancelled) setResolvedLocation({ lat, lon, name: placeName });

        // Step 2: fetch forecast
        const { startDate, endDate } = parseDateRange();
        const forecast = await fetchForecast({ lat, lon, startDate, endDate, units });
        if (!forecast) {
          if (!cancelled) {
            setError(t("weather.forecastFailed"));
            setStage("error");
          }
          return;
        }

        // Step 3: analyze
        const result = analyzePacklistAgainstWeather(allUniqueItems, forecast, units);
        if (!cancelled) {
          setWeather(forecast);
          setAnalysis(result);
          setStage("ready");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || t("weather.unknownError"));
          setStage("error");
        }
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isMetric = units !== "imperial";
  const tempLabel = (v) => v == null ? "—" : `${Math.round(v)}°${isMetric ? "C" : "F"}`;

  const triggeredReqs = analysis.filter((a) => a.triggered);
  const gaps = triggeredReqs.filter((a) => !a.covered);
  const covered = triggeredReqs.filter((a) => a.covered);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(26,36,33,0.55)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        width: "100%", maxWidth: 720, maxHeight: "92vh", overflowY: "auto",
        background: C.paper, border: `1.5px solid ${C.ink}`, padding: isMobile ? 18 : 28,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Coord>{t("weather.heading")}</Coord>
            <h3 style={{ margin: "4px 0 0", fontFamily: F.display, fontSize: isMobile ? 22 : 28, fontWeight: 700, letterSpacing: "-0.02em" }}>
              {t("weather.title")}<span style={{ color: C.rust }}>.</span>
            </h3>
            {resolvedLocation && (
              <div style={{ marginTop: 4, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                📍 {resolvedLocation.name}
              </div>
            )}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: C.ink, padding: 4 }} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        {/* === LOADING === */}
        {stage === "loading" && (
          <div style={{ padding: 24, textAlign: "center" }}>
            <div style={{ fontFamily: F.display, fontStyle: "italic", fontSize: 18, color: C.inkSoft }}>
              {t("weather.loading")}
            </div>
          </div>
        )}

        {/* === NEEDS LOCATION === */}
        {stage === "needsLocation" && (
          <div style={{ padding: 16, background: C.paperDeep, border: `1.5px solid ${C.rust}` }}>
            <div style={{ fontFamily: F.display, fontSize: 16, fontWeight: 700, marginBottom: 8 }}>{t("weather.noDestination")}</div>
            <div style={{ fontFamily: F.body, fontSize: 14, color: C.inkSoft }}>{t("weather.noDestinationHint")}</div>
          </div>
        )}

        {/* === ERROR === */}
        {stage === "error" && (
          <div style={{ padding: 16, background: C.paperDeep, border: `1.5px solid ${C.rust}`, color: C.rust }}>
            <div style={{ fontFamily: F.display, fontSize: 16, fontWeight: 700, marginBottom: 8 }}>{t("weather.errorTitle")}</div>
            <div style={{ fontFamily: F.body, fontSize: 14 }}>{error}</div>
          </div>
        )}

        {/* === READY === */}
        {stage === "ready" && weather && (
          <>
            {/* Summary bar */}
            <div style={{ marginTop: 14, padding: 14, background: C.ink, color: C.paper, display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 12 }}>
              <div>
                <div style={{ fontFamily: F.mono, fontSize: 9, opacity: 0.7, letterSpacing: "0.18em" }}>TEMP RANGE</div>
                <div style={{ marginTop: 2, fontFamily: F.display, fontSize: 18, fontWeight: 700 }}>{tempLabel(weather.tempMin)} — {tempLabel(weather.tempMax)}</div>
              </div>
              <div>
                <div style={{ fontFamily: F.mono, fontSize: 9, opacity: 0.7, letterSpacing: "0.18em" }}>RAIN</div>
                <div style={{ marginTop: 2, fontFamily: F.display, fontSize: 18, fontWeight: 700 }}>{weather.precipMaxProb || 0}%</div>
              </div>
              <div>
                <div style={{ fontFamily: F.mono, fontSize: 9, opacity: 0.7, letterSpacing: "0.18em" }}>WIND MAX</div>
                <div style={{ marginTop: 2, fontFamily: F.display, fontSize: 18, fontWeight: 700 }}>{Math.round(weather.windMax || 0)} {weather.windUnit}</div>
              </div>
              <div>
                <div style={{ fontFamily: F.mono, fontSize: 9, opacity: 0.7, letterSpacing: "0.18em" }}>UV MAX</div>
                <div style={{ marginTop: 2, fontFamily: F.display, fontSize: 18, fontWeight: 700 }}>{Math.round(weather.uvMax || 0)}</div>
              </div>
            </div>

            {/* GAPS */}
            {gaps.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div style={{ marginBottom: 10, fontFamily: F.mono, fontSize: 10, color: C.rust, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
                  ⚠ {t("weather.gapsHeading")} ({gaps.length})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {gaps.map(({ req }) => (
                    <div key={req.id} style={{ padding: 12, background: C.paperDeep, borderLeft: `3px solid ${C.rust}` }}>
                      <div style={{ fontFamily: F.display, fontSize: 16, fontWeight: 700, color: C.ink }}>{req.label}</div>
                      <div style={{ marginTop: 2, fontFamily: F.body, fontSize: 13, color: C.inkSoft }}>{req.detail(weather)}</div>
                      <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                        {t("weather.suggestKeywords")}: {req.keywords.slice(0, 4).join(", ")}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* COVERED */}
            {covered.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div style={{ marginBottom: 10, fontFamily: F.mono, fontSize: 10, color: C.forest, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
                  ✓ {t("weather.coveredHeading")} ({covered.length})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {covered.map(({ req, matchedItems }) => (
                    <div key={req.id} style={{ padding: 12, background: C.paperDeep, borderLeft: `3px solid ${C.forest}` }}>
                      <div style={{ fontFamily: F.display, fontSize: 16, fontWeight: 700, color: C.ink }}>{req.label}</div>
                      <div style={{ marginTop: 2, fontFamily: F.body, fontSize: 13, color: C.inkSoft }}>{req.detail(weather)}</div>
                      <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.05em" }}>
                        {matchedItems.slice(0, 4).map((it) => it.name).join(" · ")}
                        {matchedItems.length > 4 && `  +${matchedItems.length - 4} more`}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* All clear */}
            {triggeredReqs.length === 0 && (
              <div style={{ marginTop: 18, padding: 16, background: C.paperDeep, borderLeft: `3px solid ${C.forest}` }}>
                <div style={{ fontFamily: F.display, fontSize: 16, fontWeight: 700, color: C.forest }}>✓ {t("weather.allClear")}</div>
                <div style={{ marginTop: 4, fontFamily: F.body, fontSize: 13, color: C.inkSoft }}>{t("weather.allClearHint")}</div>
              </div>
            )}

            <div style={{ marginTop: 18, fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.1em", textAlign: "center" }}>
              {t("weather.poweredBy")} · open-meteo.com
            </div>
          </>
        )}

        <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
          <Btn variant="ghost" icon={Check} onClick={onClose} fullWidth={isMobile}>{t("common.done")}</Btn>
        </div>
      </div>
    </div>
  );
}

/* Detail view of a single packlist — shows kits with their items + standalone items */
function PacklistDetail({ packlist, kits, items, categories, onBack, onEdit, onDelete, onRemoveItem, onRemoveKit, onRemoveCategory, onEditItem, onEditKit, onEditCategory, onToggleWanted, onTogglePacked }) {
  const { t, lang, units } = useI18n();
  const { isMobile } = useViewport();
  const [confirming, setConfirming] = useState(false);
  const [weatherOpen, setWeatherOpen] = useState(false);

  // Per-trip state arrays. Default: an item is "wanted" if it appears in
  // the packlist at all. Once user touches the wanted toggle for any item,
  // we record explicit state in `wantedItemIds`. Same for packed.
  // BACKWARDS COMPAT: legacy packlists without these arrays default to
  // "wanted = all items, packed = none".
  const wantedSet = new Set(packlist.wantedItemIds || null);
  const hasWantedOverride = Array.isArray(packlist.wantedItemIds);
  const packedSet = new Set(packlist.packedItemIds || []);

  // Helpers — `isWanted(id)` and `isPacked(id)` for any item ID
  const isWanted = (id) => hasWantedOverride ? wantedSet.has(id) : true;
  const isPacked = (id) => packedSet.has(id);

  // Small checkbox component used twice per item row (red WANT, green PACKED).
  // Stops click propagation so tapping doesn't open the item edit modal.
  const Checkbox = ({ checked, color, onClick, title }) => (
    <button
      onClick={(e) => { e.stopPropagation(); onClick && onClick(); }}
      title={title}
      style={{
        width: 22, height: 22, padding: 0, flexShrink: 0,
        background: checked ? color : "transparent",
        border: `2px solid ${color}`,
        cursor: "pointer",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        color: C.paper,
      }}
      aria-label={title}
    >
      {checked && <Check size={14} strokeWidth={3} />}
    </button>
  );

  // Render the two-checkbox group for an item id. Used inline in each row.
  const ItemChecks = ({ itemId }) => (
    <div style={{ display: "inline-flex", gap: 6, flexShrink: 0 }}>
      <Checkbox
        checked={isWanted(itemId)} color={C.rust}
        onClick={() => onToggleWanted && onToggleWanted(itemId)}
        title={t("pl.wantToggle")}
      />
      <Checkbox
        checked={isPacked(itemId)} color={C.forestBright}
        onClick={() => onTogglePacked && onTogglePacked(itemId)}
        title={t("pl.packedToggle")}
      />
    </div>
  );

  // Hydrate
  const includedKits = (packlist.kitIds || []).map((id) => kits.find((k) => k.id === id)).filter(Boolean);
  const includedItems = (packlist.itemIds || []).map((id) => items.find((i) => i.id === id)).filter(Boolean);
  const includedCategories = (packlist.categoryIds || []).map((id) => categories.find((c) => c.id === id)).filter(Boolean);

  // For total unique calc — include items from referenced categories too
  const idsInKits = new Set();
  includedKits.forEach((k) => k.itemIds.forEach((iid) => idsInKits.add(iid)));
  includedItems.forEach((it) => idsInKits.add(it.id));
  // Live link: pull current items in each referenced category
  includedCategories.forEach((c) => {
    items.forEach((it) => { if (it.category === c.name) idsInKits.add(it.id); });
  });
  const totalUnique = idsInKits.size;
  const allUniqueItems = Array.from(idsInKits).map((id) => items.find((i) => i.id === id)).filter(Boolean);
  const totalKg = allUniqueItems.reduce((s, i) => s + parseKg(i.weight || ""), 0);
  const totalWeightStr = formatWeightFromKg(totalKg, units);

  // Counts for the want/packed counter at the top
  const wantedCount = allUniqueItems.filter((it) => isWanted(it.id)).length;
  const packedCount = allUniqueItems.filter((it) => isPacked(it.id)).length;

  const isEmpty = includedKits.length === 0 && includedItems.length === 0 && includedCategories.length === 0;
  const hasMetadata = packlist.dest || packlist.date || packlist.type;

  return (
    <div>
      <div style={{ marginTop: isMobile ? 16 : 24, marginBottom: 24, paddingBottom: 16, borderBottom: `1.5px solid ${C.ink}` }}>
        <button
          onClick={onBack}
          style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            background: "none", border: "none", cursor: "pointer",
            fontFamily: F.mono, fontSize: 11, color: C.muted,
            letterSpacing: "0.18em", textTransform: "uppercase",
            padding: "8px 0", marginBottom: 12,
          }}
        >
          <ArrowLeft size={14} /> {t("nav.packlists")}
        </button>
        <Coord>{packlist.dest ? packlist.dest.toUpperCase() : "PACKLIST"}</Coord>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
          {packlist.type && <TripTypeBadge iconKey={getTripType(packlist.type)?.icon || "other"} size={isMobile ? 36 : 48} />}
          <h2 style={{ margin: "0 0 0 0", fontFamily: F.display, fontSize: isMobile ? 32 : 44, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1 }}>
            {packlist.name}<span style={{ color: C.rust }}>.</span>
          </h2>
        </div>

        {/* Trip metadata strip */}
        {hasMetadata && (
          <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 12, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
            {packlist.date && <span>📅 {packlist.date}</span>}
            {packlist.type && <span>· {tOrLiteral(lang, "tt", packlist.type)}</span>}
            {packlist.dest && <span>· {packlist.dest}</span>}
          </div>
        )}

        {packlist.notes && (
          <div style={{ marginTop: 10, fontFamily: F.display, fontStyle: "italic", color: C.inkSoft, fontSize: isMobile ? 14 : 16, lineHeight: 1.5 }}>
            {packlist.notes}
          </div>
        )}
        <div style={{ marginTop: 12, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>
          {t("pl.totalUnique", { n: totalUnique })}{totalUnique > 0 ? `  /  ${totalWeightStr}` : ""}
        </div>

        {/* Want / Packed progress counter + legend explaining the boxes.
            Only renders when the packlist has items. */}
        {totalUnique > 0 && (
          <div style={{
            marginTop: 12, padding: 12,
            background: C.paperDeep, border: `1px solid ${C.line}`,
          }}>
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 8 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: F.mono, fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: C.rust, fontWeight: 700 }}>
                <span style={{ width: 14, height: 14, border: `2px solid ${C.rust}`, background: C.rust, display: "inline-block" }}></span>
                {t("pl.colWant")} — {wantedCount}/{totalUnique}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: F.mono, fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: C.forestBright, fontWeight: 700 }}>
                <span style={{ width: 14, height: 14, border: `2px solid ${C.forestBright}`, background: C.forestBright, display: "inline-block" }}></span>
                {t("pl.colPacked")} — {packedCount}/{wantedCount}
              </span>
            </div>
            <div style={{ fontFamily: F.body, fontStyle: "italic", fontSize: 12, color: C.inkSoft, lineHeight: 1.4 }}>
              {t("pl.legend")}
            </div>
          </div>
        )}

        <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Btn variant="rust" icon={Pencil} onClick={onEdit}>{t("pl.editBtn")}</Btn>
          <Btn variant="ghost" icon={Cloud} onClick={() => setWeatherOpen(true)}>{t("weather.btn")}</Btn>
          <Btn variant="ghost" icon={Download} onClick={() => generatePacklistPDF({ packlist, kits, items, categories, units, lang })}>{t("pl.downloadPDF")}</Btn>
          <Btn variant="ghost" icon={Trash2} onClick={() => setConfirming(true)}>{t("pl.deleteBtn")}</Btn>
        </div>

        {confirming && (
          <div style={{ marginTop: 14, padding: 14, background: C.paperDeep, border: `1.5px dashed ${C.rust}` }}>
            <div style={{ fontFamily: F.body, fontSize: 14, color: C.inkSoft, marginBottom: 12 }}>
              {t("pl.confirmDelete")}
            </div>
            <div style={{ display: "flex", gap: 8, flexDirection: isMobile ? "column-reverse" : "row" }}>
              <Btn variant="ghost" icon={X} onClick={() => setConfirming(false)} fullWidth={isMobile}>{t("common.cancel")}</Btn>
              <Btn variant="rust" icon={Trash2} onClick={() => { onDelete(); setConfirming(false); }} fullWidth={isMobile}>{t("pl.confirmYes")}</Btn>
            </div>
          </div>
        )}
      </div>

      {isEmpty && (
        <EmptyState label={t("pl.detailEmpty")} hint={t("pl.empty")} />
      )}

      {/* CATEGORIES section — each category as a header with its items listed inline */}
      {includedCategories.length > 0 && (
        <div style={{ marginTop: 16, marginBottom: 32 }}>
          <div style={{ marginBottom: 14, paddingBottom: 6, borderBottom: `1px dashed ${C.line}` }}>
            <span style={{ fontFamily: F.display, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
              {t("trips.packCategoriesHeading")}
            </span>
            <span style={{ marginLeft: 10, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>
              {includedCategories.length}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            {includedCategories.map((c) => {
              const Icon = iconFor(c.icon);
              const catItems = items.filter((i) => i.category === c.name);
              return (
                <div key={c.id}>
                  {/* Header row — tap to open category modal; X to remove */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, paddingBottom: 6, borderBottom: `1px solid ${C.line}` }}>
                    <Icon size={18} strokeWidth={1.4} color={C.forest} />
                    <button
                      onClick={() => onEditCategory && onEditCategory(c.id)}
                      style={{
                        flex: 1, minWidth: 0, textAlign: "left",
                        background: "none", border: "none", padding: 0, cursor: onEditCategory ? "pointer" : "default",
                      }}>
                      <div style={{ fontFamily: F.display, fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em", color: C.ink }}>
                        {tOrLiteral(lang, "cat", c.name)}
                      </div>
                      <div style={{ marginTop: 2, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                        {t("pl.catLabel")} · {catItems.length} {catItems.length === 1 ? "item" : "items"}
                      </div>
                    </button>
                    {onRemoveCategory && (
                      <button onClick={(e) => { e.stopPropagation(); onRemoveCategory(c.id); }}
                        style={{ width: 30, height: 30, background: "transparent", border: `1px solid ${C.rust}`, color: C.rust, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                        title="Remove from this list" aria-label="Remove">
                        <X size={13} />
                      </button>
                    )}
                  </div>
                  {/* Inline item list */}
                  {catItems.length === 0 ? (
                    <div style={{ paddingLeft: 28, fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.inkSoft }}>
                      {t("kitDetail.empty")}
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      {catItems.map((it) => (
                        <div key={it.id}
                          onClick={() => onEditItem && onEditItem(it.id)}
                          style={{
                            display: "flex", alignItems: "center", gap: 10,
                            padding: "8px 12px 8px 28px",
                            borderBottom: `1px solid ${C.line}`,
                            cursor: onEditItem ? "pointer" : "default",
                          }}>
                          <ItemChecks itemId={it.id} />
                          <span style={{ flex: 1, minWidth: 0, fontFamily: F.body, fontSize: 14, color: C.ink }}>
                            {it.name}
                          </span>
                          {it.weight && (
                            <span style={{ fontFamily: F.mono, fontSize: 11, color: C.muted, fontWeight: 600 }}>
                              {formatWeight(it.weight, units)}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {includedKits.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ marginBottom: 14, paddingBottom: 6, borderBottom: `1px dashed ${C.line}` }}>
            <span style={{ fontFamily: F.display, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
              {t("pl.detailKits")}
            </span>
            <span style={{ marginLeft: 10, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>
              {includedKits.length}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            {includedKits.map((k) => {
              const kitItems = (k.itemIds || []).map((id) => items.find((i) => i.id === id)).filter(Boolean);
              const kitKg = kitItems.reduce((s, i) => s + parseKg(i.weight || ""), 0);
              const kitWeightStr = formatWeightFromKg(kitKg, units);
              return (
                <div key={k.id}>
                  {/* Header row — tap to open kit modal; X to remove */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, paddingBottom: 6, borderBottom: `1px solid ${C.line}` }}>
                    <button
                      onClick={() => onEditKit && onEditKit(k.id)}
                      style={{
                        flex: 1, minWidth: 0, textAlign: "left",
                        background: "none", border: "none", padding: 0, cursor: onEditKit ? "pointer" : "default",
                      }}>
                      <div style={{ fontFamily: F.display, fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em", color: C.ink }}>
                        {k.name}
                      </div>
                      <div style={{ marginTop: 2, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                        KIT · {kitItems.length} {kitItems.length === 1 ? "item" : "items"} · {kitWeightStr}
                        {k.category ? `  ·  ${tOrLiteral(lang, "cat", k.category)}` : ""}
                      </div>
                    </button>
                    {onRemoveKit && (
                      <button onClick={(e) => { e.stopPropagation(); onRemoveKit(k.id); }}
                        style={{ width: 30, height: 30, background: "transparent", border: `1px solid ${C.rust}`, color: C.rust, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                        title="Remove from this list" aria-label="Remove">
                        <X size={13} />
                      </button>
                    )}
                  </div>
                  {/* Inline item list */}
                  {kitItems.length === 0 ? (
                    <div style={{ paddingLeft: 12, fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.inkSoft }}>
                      {t("kitDetail.empty")}
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      {/* Tiny column label row showing what the two boxes mean */}
                      <div style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "2px 12px 4px 12px",
                        fontFamily: F.mono, fontSize: 8,
                        letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700,
                      }}>
                        <div style={{ display: "inline-flex", gap: 6, flexShrink: 0 }}>
                          <span style={{ width: 22, textAlign: "center", color: C.rust }}>{lang === "es" ? "LLEV" : "WANT"}</span>
                          <span style={{ width: 22, textAlign: "center", color: C.forestBright }}>{lang === "es" ? "EMP" : "PKD"}</span>
                        </div>
                      </div>
                      {kitItems.map((it) => (
                        <div key={it.id}
                          onClick={() => onEditItem && onEditItem(it.id)}
                          style={{
                            display: "flex", alignItems: "center", gap: 10,
                            padding: "8px 12px 8px 12px",
                            borderBottom: `1px solid ${C.line}`,
                            cursor: onEditItem ? "pointer" : "default",
                          }}>
                          <ItemChecks itemId={it.id} />
                          <span style={{ flex: 1, minWidth: 0, fontFamily: F.body, fontSize: 14, color: C.ink }}>
                            {it.name}
                          </span>
                          {it.category && (
                            <span style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: C.muted }}>
                              {tOrLiteral(lang, "cat", it.category)}
                            </span>
                          )}
                          {it.weight && (
                            <span style={{ fontFamily: F.mono, fontSize: 11, color: C.muted, fontWeight: 600 }}>
                              {formatWeight(it.weight, units)}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {includedItems.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <div style={{ marginBottom: 14, paddingBottom: 6, borderBottom: `1px dashed ${C.line}` }}>
            <span style={{ fontFamily: F.display, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
              {t("pl.detailItems")}
            </span>
            <span style={{ marginLeft: 10, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>
              {includedItems.length}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {includedItems.map((it, idx) => (
              <div key={it.id}
                onClick={() => onEditItem && onEditItem(it.id)}
                style={{
                  background: C.paper, border: `1px solid ${C.line}`, padding: 12,
                  display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
                  cursor: onEditItem ? "pointer" : "default",
                }}>
                <ItemChecks itemId={it.id} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.12em" }}>
                    {String(idx + 1).padStart(3, "0")}
                  </div>
                  <div style={{ marginTop: 2, fontFamily: F.display, fontSize: 16, fontWeight: 600, lineHeight: 1.2 }}>
                    {it.name}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                    <span style={{ padding: "2px 6px", fontFamily: F.mono, fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", border: `1px solid ${C.ink}`, fontWeight: 700 }}>
                      {tOrLiteral(lang, "cat", it.category)}
                    </span>
                    <span style={{ fontFamily: F.mono, fontSize: 11, color: C.inkSoft, fontWeight: 700 }}>{formatWeight(it.weight, units)}</span>
                  </div>
                  {onRemoveItem && (
                    <button onClick={(e) => { e.stopPropagation(); onRemoveItem(it.id); }}
                      style={{ width: 30, height: 30, background: "transparent", border: `1px solid ${C.rust}`, color: C.rust, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                      title="Remove from this list" aria-label="Remove">
                      <X size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Weather check modal — opens when user taps the Weather button */}
      {weatherOpen && (
        <WeatherCheckModal
          packlist={packlist}
          items={items}
          kits={kits}
          categories={categories}
          onClose={() => setWeatherOpen(false)}
        />
      )}
    </div>
  );
}

/* ============================================================
   INBOX — top-level screen showing shares received from other users.
   Pending shares can be reviewed (with referenced-item opt-ins) and
   imported into the user's inventory, or declined.
   Imported tab shows history. Import-file tab accepts JSON.
   ============================================================ */
function Inbox({
  go,
  inbox, setInbox,
  items, setItems,
  kits, setKits,
  categories, setCategories,
  trips, setTrips,
  packlists, setPacklists,
  shareService,
}) {
  const { t, locale, lang } = useI18n();
  const { isMobile } = useViewport();
  const [tab, setTab] = useState("pending");        // "pending" | "imported" | "import"
  const [reviewingId, setReviewingId] = useState(null);
  const [decliningId, setDecliningId] = useState(null);
  const [fileError, setFileError] = useState("");
  const [fileImportSuccess, setFileImportSuccess] = useState(false);

  const pending = inbox.filter((s) => s.status === "pending");
  const imported = inbox.filter((s) => s.status === "imported");
  const reviewing = reviewingId ? inbox.find((s) => s.id === reviewingId) : null;

  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(locale, { month: "short", day: "2-digit" });
  };

  const declineShare = (id) => {
    shareService.setShareStatus(id, "declined", { declinedAt: new Date().toISOString() });
    setDecliningId(null);
  };

  // Handle file upload
  const handleFile = (file) => {
    if (!file) return;
    setFileError("");
    setFileImportSuccess(false);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const parsed = shareService.parseImportFile(text);
      if (!parsed) {
        setFileError(t("inbox.fileInvalid"));
        return;
      }
      // Add to inbox as pending
      setInbox([parsed, ...inbox]);
      setFileImportSuccess(true);
      setTab("pending");
      setReviewingId(parsed.id);
    };
    reader.onerror = () => setFileError(t("inbox.fileInvalid"));
    reader.readAsText(file);
  };

  // === Import flow: turn a pending share into real entries ===
  const importShare = (share, opts) => {
    const { selectedItemIds, selectedKitIds } = opts;
    const p = share.payload || {};

    if (share.kind === "kit") {
      // Add selected items first
      const incomingItems = (p.items || []).filter((i) => selectedItemIds.has(i.id));
      // Re-id items to avoid collisions
      const remappedIds = {};
      const newItems = incomingItems.map((it) => {
        const newId = uid("it");
        remappedIds[it.id] = newId;
        return { ...it, id: newId, packed: false };
      });
      // Add the kit, remapping its itemIds (drop any that the user opted out of)
      const newKitId = uid("kit");
      const newKit = {
        ...p.kit,
        id: newKitId,
        itemIds: (p.kit.itemIds || []).map((id) => remappedIds[id]).filter(Boolean),
      };
      // Live link bookkeeping
      if (share.mode === "live") {
        newKit.linkedFrom = { username: share.fromUsername, name: share.fromName, sharedAt: share.sentAt };
      }
      setItems([...newItems, ...items]);
      setKits([newKit, ...kits]);
    }

    if (share.kind === "category") {
      // Avoid duplicate category by name — skip if already there
      const cat = p.category;
      const exists = categories.find((c) => c.name === cat.name);
      let categoryName = cat.name;
      if (!exists) {
        const newCat = { ...cat, id: uid("cat") };
        if (share.mode === "live") newCat.linkedFrom = { username: share.fromUsername, name: share.fromName, sharedAt: share.sentAt };
        setCategories([newCat, ...categories]);
      }
      // Selected items, remapped + assigned to that category name
      const incomingItems = (p.items || []).filter((i) => selectedItemIds.has(i.id));
      const newItems = incomingItems.map((it) => ({ ...it, id: uid("it"), category: categoryName, packed: false }));
      if (newItems.length) setItems([...newItems, ...items]);
    }

    if (share.kind === "trip") {
      const trip = p.trip || {};
      const newTrip = { ...trip, id: uid("trip") };
      if (share.mode === "live") newTrip.linkedFrom = { username: share.fromUsername, name: share.fromName, sharedAt: share.sentAt };
      setTrips([newTrip, ...trips]);
      // Optionally bring kits + items + packlist
      const incomingItems = (p.items || []).filter((i) => selectedItemIds.has(i.id));
      const itemRemap = {};
      const newItems = incomingItems.map((it) => {
        const newId = uid("it");
        itemRemap[it.id] = newId;
        return { ...it, id: newId, packed: false };
      });
      if (newItems.length) setItems([...newItems, ...items]);

      const incomingKits = (p.kits || []).filter((k) => selectedKitIds.has(k.id));
      const kitRemap = {};
      const newKits = incomingKits.map((k) => {
        const newId = uid("kit");
        kitRemap[k.id] = newId;
        return {
          ...k,
          id: newId,
          itemIds: (k.itemIds || []).map((id) => itemRemap[id]).filter(Boolean),
        };
      });
      if (newKits.length) setKits([...newKits, ...kits]);

      if (p.packlist) {
        const newPl = {
          ...p.packlist,
          id: uid("pl"),
          kitIds: (p.packlist.kitIds || []).map((id) => kitRemap[id]).filter(Boolean),
          itemIds: (p.packlist.itemIds || []).map((id) => itemRemap[id]).filter(Boolean),
        };
        if (share.mode === "live") newPl.linkedFrom = { username: share.fromUsername, name: share.fromName, sharedAt: share.sentAt };
        setPacklists([newPl, ...packlists]);
      }
    }

    shareService.setShareStatus(share.id, "imported", { importedAt: new Date().toISOString() });
    setReviewingId(null);
  };

  // Detail view: render the import preview
  if (reviewing) {
    return (
      <div>
        <Header go={go} active="inbox" />
        <div style={{ padding: padX(isMobile) }}>
          {reviewing.kind === "location" ? (
            <LocationSharePreview
              share={reviewing}
              onClose={() => setReviewingId(null)}
              onMarkSeen={() => importShare(reviewing, { selectedItemIds: new Set(), selectedKitIds: new Set() })}
            />
          ) : (
            <SharePreview
              share={reviewing}
              existingItems={items}
              existingKits={kits}
              onCancel={() => setReviewingId(null)}
              onAccept={(opts) => importShare(reviewing, opts)}
            />
          )}
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <div>
      <Header go={go} active="inbox" />
      <div style={{ padding: padX(isMobile) }}>
        <div style={{ marginTop: isMobile ? 24 : 40 }}>
          <Coord>{t("inbox.section")}</Coord>
          <h1 style={{ margin: "12px 0", fontFamily: F.display, fontSize: "clamp(36px, 6vw, 72px)", fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 0.95 }}>
            {t("inbox.titleA")} <span style={{ fontStyle: "italic", color: C.forest }}>{t("inbox.titleB")}</span><span style={{ color: C.rust }}>.</span>
          </h1>
          <div style={{ marginTop: 6, fontFamily: F.display, fontStyle: "italic", color: C.inkSoft, fontSize: isMobile ? 15 : 17 }}>
            {t("inbox.tagline")}
          </div>
        </div>

        {/* Tab strip */}
        <div style={{ marginTop: isMobile ? 24 : 36, display: "flex", borderBottom: `1.5px solid ${C.ink}`, overflowX: "auto", scrollbarWidth: "none" }}>
          {[
            ["pending", t("inbox.tabPending", { n: pending.length })],
            ["imported", t("inbox.tabImported", { n: imported.length })],
            ["import", t("inbox.tabImport")],
          ].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              style={{
                padding: isMobile ? "10px 14px" : "12px 20px",
                border: "none",
                cursor: "pointer",
                fontFamily: F.mono,
                fontSize: 11,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                background: tab === k ? C.ink : "transparent",
                color: tab === k ? C.paper : C.ink,
                fontWeight: 700,
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}>
              {l}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 20 }}>
          {/* PENDING tab */}
          {tab === "pending" && (
            pending.length === 0 ? (
              <EmptyState label={t("inbox.empty")} hint={t("inbox.emptyHint")} />
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 16 }}>
                {pending.map((s) => (
                  <InboxCard
                    key={s.id}
                    share={s}
                    fmtDate={fmtDate}
                    onReview={() => setReviewingId(s.id)}
                    onDecline={() => setDecliningId(s.id)}
                    declining={decliningId === s.id}
                    confirmDecline={() => declineShare(s.id)}
                    cancelDecline={() => setDecliningId(null)}
                  />
                ))}
              </div>
            )
          )}

          {/* IMPORTED tab */}
          {tab === "imported" && (
            imported.length === 0 ? (
              <EmptyState label={t("inbox.emptyImported")} hint={t("inbox.emptyHint")} />
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 16 }}>
                {imported.map((s) => (
                  <div key={s.id} style={{ background: C.paper, border: `1.5px solid ${C.line}`, padding: 16, opacity: 0.85 }}>
                    <Coord>{s.kind.toUpperCase()}</Coord>
                    <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>
                      {s.payload?.kit?.name || s.payload?.category?.name || s.payload?.trip?.name || s.kind}
                    </div>
                    <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                      {t("inbox.from")} @{s.fromUsername}  /  {t("inbox.acceptedAt", { date: fmtDate(s.importedAt || s.sentAt) })}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}

          {/* IMPORT FILE tab */}
          {tab === "import" && (
            <div style={{ maxWidth: 520 }}>
              <div style={{ marginBottom: 14, fontFamily: F.display, fontSize: isMobile ? 18 : 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
                {t("inbox.fileImportTitle")}
              </div>
              <div style={{ marginBottom: 14, fontFamily: F.body, fontSize: 13, color: C.muted, fontStyle: "italic" }}>
                {t("inbox.fileImportHint")}
              </div>
              <label style={{
                display: "inline-block",
                padding: "10px 18px",
                background: C.rust,
                color: C.paper,
                cursor: "pointer",
                fontFamily: F.body,
                fontSize: 12,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                fontWeight: 700,
              }}>
                <input type="file" accept=".json,application/json"
                  onChange={(e) => handleFile(e.target.files?.[0])}
                  style={{ display: "none" }} />
                + {t("inbox.fileSelect")}
              </label>
              {fileError && (
                <div style={{ marginTop: 14, padding: 12, background: C.paperDeep, border: `1.5px solid ${C.rust}`, color: C.rust, fontFamily: F.body, fontSize: 13 }}>
                  {fileError}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <Footer />
    </div>
  );
}

/* ============================================================
   LocationSharePreview — view-only preview for location shares.
   Unlike kit/category/trip shares, there's nothing to import here.
   The user just sees the coordinates, place name, and a Maps link.
   "Mark as seen" moves it to the Imported tab.
   ============================================================ */
function LocationSharePreview({ share, onClose, onMarkSeen }) {
  const { t, locale } = useI18n();
  const { isMobile } = useViewport();
  const p = share.payload || {};
  const lat = p.lat;
  const lon = p.lon;
  const fmtCaptured = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(locale, { month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div style={{ marginTop: isMobile ? 24 : 40, maxWidth: 720 }}>
      <button onClick={onClose}
        style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", fontFamily: F.mono, fontSize: 11, color: C.ink, letterSpacing: "0.18em", textTransform: "uppercase", padding: 0, marginBottom: 18 }}>
        <ArrowLeft size={14} /> {t("common.back")}
      </button>

      <Coord>LOCATION SHARE</Coord>
      <h2 style={{ margin: "8px 0 16px", fontFamily: F.display, fontSize: isMobile ? 28 : 36, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05 }}>
        @{share.fromUsername} {t("loc.fromShare")}<span style={{ color: C.rust }}>.</span>
      </h2>

      {/* Coordinates card */}
      <div style={{ padding: isMobile ? 18 : 24, background: C.paper, border: `1.5px solid ${C.ink}`, marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
          <div style={{ width: 44, height: 44, flexShrink: 0, background: C.forest, color: C.paper, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            <MapPin size={22} strokeWidth={1.6} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {lat != null && lon != null ? (
              <>
                <div style={{ fontFamily: F.display, fontSize: isMobile ? 22 : 28, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1, color: C.ink, wordBreak: "break-word" }}>
                  {formatCoords(lat, lon)}
                </div>
                {p.placeName && (
                  <div style={{ marginTop: 4, fontFamily: F.body, fontSize: isMobile ? 14 : 16, fontStyle: "italic", color: C.inkSoft }}>
                    {p.placeName}
                  </div>
                )}
                {p.capturedAt && (
                  <div style={{ marginTop: 8, fontFamily: F.mono, fontSize: 10, letterSpacing: "0.15em", color: C.muted, textTransform: "uppercase" }}>
                    {t("loc.lastUpdated")}: {fmtCaptured(p.capturedAt)}
                  </div>
                )}
              </>
            ) : (
              <div style={{ fontFamily: F.body, fontSize: 14, color: C.inkSoft, fontStyle: "italic" }}>
                Location data missing.
              </div>
            )}
          </div>
        </div>

        {p.note && (
          <div style={{ marginTop: 16, padding: 12, background: C.paperDeep, borderLeft: `3px solid ${C.ochre}` }}>
            <div style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 4 }}>
              Note from @{share.fromUsername}
            </div>
            <div style={{ fontFamily: F.body, fontSize: 14, fontStyle: "italic", color: C.ink, lineHeight: 1.4 }}>
              {p.note}
            </div>
          </div>
        )}

        {lat != null && lon != null && (
          <div style={{ marginTop: 18, display: "flex", flexWrap: "wrap", gap: 8 }}>
            <a href={p.mapsUrl || googleMapsUrl(lat, lon)} target="_blank" rel="noopener noreferrer"
              style={{ padding: "10px 16px", background: C.rust, border: `1.5px solid ${C.rust}`, color: C.paper, textDecoration: "none", cursor: "pointer", fontFamily: F.mono, fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 6 }}>
              🗺 {t("loc.openMaps")}
            </a>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexDirection: isMobile ? "column-reverse" : "row" }}>
        <Btn variant="ghost" icon={X} onClick={onClose} fullWidth={isMobile}>{t("common.cancel")}</Btn>
        <Btn variant="rust" icon={Check} onClick={onMarkSeen} fullWidth={isMobile}>
          {t("common.done") || "Done"}
        </Btn>
      </div>
    </div>
  );
}

// Inbox card for a pending share
function InboxCard({ share, fmtDate, onReview, onDecline, declining, confirmDecline, cancelDecline }) {
  const { t } = useI18n();
  const { isMobile } = useViewport();
  const entityName =
    share.kind === "location" ? (share.payload?.placeName || (share.payload?.lat && share.payload?.lon ? formatCoords(share.payload.lat, share.payload.lon) : t("loc.cardTitle")))
    : (share.payload?.kit?.name || share.payload?.category?.name || share.payload?.trip?.name || share.kind);
  const modeLabel = share.mode === "live" ? t("inbox.modeBadgeLive") : t("inbox.modeBadgeCopy");
  const modeColor = share.mode === "live" ? C.rust : C.forest;

  return (
    <div style={{ background: C.paper, border: `1.5px solid ${C.ink}`, padding: 16, position: "relative", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
        <Coord>{share.kind.toUpperCase()}</Coord>
        <span style={{
          padding: "3px 8px",
          fontFamily: F.mono,
          fontSize: 9,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          border: `1.5px solid ${modeColor}`,
          color: modeColor,
          fontWeight: 700,
        }}>
          {modeLabel}
        </span>
      </div>
      <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05 }}>
        {entityName}
      </div>
      <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
        {t("inbox.from")} <b style={{ color: C.ink }}>@{share.fromUsername}</b>
        {share.fromRegion && (
          <span style={{ marginLeft: 6 }}><RegionBadge code={share.fromRegion} /></span>
        )}
      </div>
      <div style={{ marginTop: 4, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
        {t("inbox.received")} {fmtDate(share.sentAt)}
      </div>

      <div style={{ flex: 1 }} />

      {!declining ? (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          <Btn variant="rust" icon={ChevronRight} onClick={onReview} fullWidth={true}>
            {t("inbox.review")}
          </Btn>
          <Btn variant="ghost" icon={X} onClick={onDecline} fullWidth={true}>
            {t("inbox.decline")}
          </Btn>
        </div>
      ) : (
        <div style={{ marginTop: 14, padding: 12, background: C.paperDeep, border: `1.5px dashed ${C.rust}` }}>
          <div style={{ fontFamily: F.body, fontSize: 13, color: C.inkSoft, marginBottom: 10 }}>
            {t("inbox.confirmDecline")}
          </div>
          <div style={{ display: "flex", gap: 8, flexDirection: isMobile ? "column-reverse" : "row" }}>
            <Btn variant="ghost" icon={X} onClick={cancelDecline} fullWidth={isMobile}>{t("share.cancel")}</Btn>
            <Btn variant="rust" icon={Trash2} onClick={confirmDecline} fullWidth={isMobile}>{t("inbox.confirmYes")}</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

// Preview screen for a share — shows referenced items + kits with checkboxes,
// then the user accepts or cancels.
function SharePreview({ share, existingItems, existingKits, onCancel, onAccept }) {
  const { t, lang } = useI18n();
  const { isMobile } = useViewport();
  const p = share.payload || {};

  const refItems = p.items || [];
  const refKits = p.kits || [];
  const packlist = p.packlist || null;

  // Default: all selected
  const [selectedItemIds, setSelectedItemIds] = useState(() => new Set(refItems.map((i) => i.id)));
  const [selectedKitIds, setSelectedKitIds] = useState(() => new Set(refKits.map((k) => k.id)));

  const toggleItem = (id) => {
    const next = new Set(selectedItemIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedItemIds(next);
  };
  const toggleKit = (id) => {
    const next = new Set(selectedKitIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedKitIds(next);
  };

  const itemAlreadyExists = (it) => existingItems.some((x) => x.name.toLowerCase() === it.name.toLowerCase());
  const kitAlreadyExists = (k) => existingKits.some((x) => x.name.toLowerCase() === k.name.toLowerCase());

  const entityName = p.kit?.name || p.category?.name || p.trip?.name || share.kind;
  const modeBadge = share.mode === "live" ? t("inbox.modeBadgeLive") : t("inbox.modeBadgeCopy");
  const modeColor = share.mode === "live" ? C.rust : C.forest;

  return (
    <div>
      {/* Header */}
      <div style={{ marginTop: isMobile ? 16 : 24, marginBottom: 24, paddingBottom: 16, borderBottom: `1.5px solid ${C.ink}` }}>
        <button onClick={onCancel}
          style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", padding: "8px 0", marginBottom: 12 }}>
          <ArrowLeft size={14} /> {t("nav.inbox")}
        </button>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Coord>{share.kind.toUpperCase()}</Coord>
            <h2 style={{ margin: "8px 0 8px", fontFamily: F.display, fontSize: isMobile ? 30 : 40, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1 }}>
              {entityName}<span style={{ color: C.rust }}>.</span>
            </h2>
            <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>
              {t("inbox.from")} <b style={{ color: C.ink }}>@{share.fromUsername}</b>
            </div>
          </div>
          <span style={{ padding: "4px 10px", fontFamily: F.mono, fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", border: `1.5px solid ${modeColor}`, color: modeColor, fontWeight: 700 }}>
            {modeBadge}
          </span>
        </div>
      </div>

      {/* Packlist preview (trips with included packlist) */}
      {packlist && (
        <div style={{ marginBottom: 20, padding: 14, background: C.paperDeep, border: `1px dashed ${C.line}` }}>
          <Coord>{t("inbox.previewPacklist").toUpperCase()}</Coord>
          <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>{packlist.name}</div>
          {packlist.notes && <div style={{ marginTop: 4, fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.inkSoft }}>{packlist.notes}</div>}
        </div>
      )}

      {/* Referenced kits */}
      {refKits.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ marginBottom: 6, paddingBottom: 6, borderBottom: `1px dashed ${C.line}`, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontFamily: F.display, fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>{t("inbox.previewKits")}</span>
            <span style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.15em" }}>{selectedKitIds.size}/{refKits.length}</span>
          </div>
          <div style={{ marginBottom: 10, fontFamily: F.body, fontSize: 12, color: C.muted, fontStyle: "italic" }}>
            {t("inbox.previewKitsHint")}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {refKits.map((k) => {
              const sel = selectedKitIds.has(k.id);
              const exists = kitAlreadyExists(k);
              return (
                <button key={k.id} onClick={() => toggleKit(k.id)}
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: 10, background: sel ? C.paper : "transparent", border: `1.5px solid ${sel ? C.forest : C.line}`, cursor: "pointer", textAlign: "left" }}>
                  <span style={{ width: 22, height: 22, flexShrink: 0, border: `1.5px solid ${sel ? C.forest : C.muted}`, background: sel ? C.forest : "transparent", color: C.paper, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    {sel && <Check size={13} strokeWidth={3} />}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: F.display, fontSize: 14, fontWeight: 600 }}>{k.name}</div>
                    <div style={{ marginTop: 2, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                      {(k.itemIds || []).length} items
                      {exists && <span style={{ marginLeft: 8, fontStyle: "italic", textTransform: "none", letterSpacing: 0 }}>{t("inbox.alreadyHave")}</span>}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Referenced items */}
      {refItems.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ marginBottom: 6, paddingBottom: 6, borderBottom: `1px dashed ${C.line}`, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontFamily: F.display, fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>{t("inbox.previewItems")}</span>
            <span style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.15em" }}>{selectedItemIds.size}/{refItems.length}</span>
          </div>
          <div style={{ marginBottom: 10, fontFamily: F.body, fontSize: 12, color: C.muted, fontStyle: "italic" }}>
            {t("inbox.previewItemsHint")}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 360, overflowY: "auto" }}>
            {refItems.map((it) => {
              const sel = selectedItemIds.has(it.id);
              const exists = itemAlreadyExists(it);
              return (
                <button key={it.id} onClick={() => toggleItem(it.id)}
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: 8, background: sel ? C.paper : "transparent", border: `1.5px solid ${sel ? C.forest : C.line}`, cursor: "pointer", textAlign: "left" }}>
                  <span style={{ width: 20, height: 20, flexShrink: 0, border: `1.5px solid ${sel ? C.forest : C.muted}`, background: sel ? C.forest : "transparent", color: C.paper, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    {sel && <Check size={12} strokeWidth={3} />}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: F.body, fontSize: 13, fontWeight: 500 }}>{it.name}</div>
                    <div style={{ marginTop: 1, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em" }}>
                      {tOrLiteral(lang, "cat", it.category)}  ·  {it.weight}
                      {exists && <span style={{ marginLeft: 8, fontStyle: "italic" }}>{t("inbox.alreadyHave")}</span>}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state if there's nothing selectable */}
      {refItems.length === 0 && refKits.length === 0 && (
        <div style={{ marginBottom: 24, padding: 16, background: C.paperDeep, border: `1px dashed ${C.line}`, fontFamily: F.body, fontSize: 13, color: C.inkSoft, fontStyle: "italic" }}>
          {share.kind === "category" ? "Just the category itself — no items came with this share." : ""}
          {share.kind === "trip" ? "Just the trip details — no kits or items came with this share." : ""}
        </div>
      )}

      {/* Actions */}
      <div style={{ marginTop: 24, display: "flex", gap: 10, flexDirection: isMobile ? "column-reverse" : "row", justifyContent: isMobile ? "stretch" : "flex-end" }}>
        <Btn variant="ghost" icon={X} onClick={onCancel} fullWidth={isMobile}>{t("share.cancel")}</Btn>
        <Btn variant="rust" icon={Check} onClick={() => onAccept({ selectedItemIds, selectedKitIds })} fullWidth={isMobile}>
          {t("inbox.accept")}
        </Btn>
      </div>
    </div>
  );
}

/* ============================================================
   AdminSubmissionsReview — full-screen overlay, admin-only.
   Lists every submission across all users with status filters
   (Pending / Approved / Rejected / All). Tap a row to see the
   full detail modal where the admin can Approve or Reject.
   ============================================================ */
function AdminSubmissionsReview({ onClose }) {
  const { t, locale } = useI18n();
  const { isMobile } = useViewport();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("pending");
  const [openId, setOpenId] = useState(null);
  const [error, setError] = useState("");

  const refresh = async () => {
    setLoading(true);
    setError("");
    const result = await supabaseService.fetchAllSubmissions(statusFilter === "all" ? null : statusFilter);
    if (result.error) setError(result.error);
    setItems(result.items || []);
    setLoading(false);
  };

  useEffect(() => { refresh(); }, [statusFilter]);

  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(locale, { month: "short", day: "2-digit", year: "numeric" });
  };

  const statusInfo = (s) => {
    if (s === "approved") return { label: t("lib.subStatusApproved"), color: C.forest };
    if (s === "rejected") return { label: t("lib.subStatusRejected"), color: C.rust };
    return { label: t("lib.subStatusPending"), color: C.muted };
  };

  const openItem = openId ? items.find((i) => i.id === openId) : null;

  return (
    <div style={{
      position: "fixed", inset: 0, background: C.paper, zIndex: 950,
      overflowY: "auto", padding: isMobile ? 16 : 32,
    }}>
      <div style={{ maxWidth: 920, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <button onClick={onClose}
            style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              background: "none", border: "none", cursor: "pointer",
              fontFamily: F.mono, fontSize: 11, color: C.muted,
              letterSpacing: "0.18em", textTransform: "uppercase",
              padding: "8px 0",
            }}>
            <ArrowLeft size={14} /> {t("common.back")}
          </button>
          <Coord>{t("admin.reviewHeading")}</Coord>
        </div>

        <h2 style={{ margin: "0 0 6px", fontFamily: F.display, fontSize: isMobile ? 28 : 38, fontWeight: 700, letterSpacing: "-0.02em" }}>
          {t("admin.reviewTitle")}<span style={{ color: C.rust }}>.</span>
        </h2>
        <div style={{ marginBottom: 22, fontFamily: F.body, fontStyle: "italic", color: C.inkSoft }}>
          {t("admin.reviewSub")}
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap" }}>
          {["pending", "approved", "rejected", "all"].map((s) => {
            const active = statusFilter === s;
            return (
              <button key={s} onClick={() => setStatusFilter(s)}
                style={{
                  padding: "8px 14px",
                  background: active ? C.ink : "transparent",
                  color: active ? C.paper : C.ink,
                  border: `1.5px solid ${C.ink}`,
                  cursor: "pointer",
                  fontFamily: F.mono, fontSize: 11,
                  letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700,
                }}>
                {t(`admin.filter.${s}`)}
              </button>
            );
          })}
        </div>

        {error && (
          <div style={{ padding: 12, marginBottom: 14, background: C.paperDeep, border: `1.5px solid ${C.rust}`, color: C.rust, fontFamily: F.body, fontSize: 13 }}>
            ⚠ {error}
          </div>
        )}

        {loading ? (
          <div style={{ padding: 24, textAlign: "center", fontFamily: F.display, fontStyle: "italic", color: C.inkSoft }}>
            {t("common.loading")}
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: 24, background: C.paperDeep, border: `1px dashed ${C.line}`, textAlign: "center" }}>
            <div style={{ fontFamily: F.display, fontStyle: "italic", fontSize: 16, color: C.inkSoft }}>{t("admin.empty")}</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map((s) => {
              const status = statusInfo(s.status);
              return (
                <button key={s.id} onClick={() => setOpenId(s.id)}
                  style={{
                    display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12,
                    padding: 14, background: C.paper,
                    border: `1.5px solid ${C.line}`,
                    cursor: "pointer", textAlign: "left",
                  }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Coord>{s.kind.toUpperCase()}{s.activity ? `  ·  ${s.activity}` : ""}</Coord>
                    <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1 }}>{s.title}</div>
                    <div style={{ marginTop: 4, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                      @{s.publisher_username}{s.publisher_region ? ` · ${s.publisher_region}` : ""} · {fmtDate(s.created_at)}
                    </div>
                  </div>
                  <span style={{
                    padding: "3px 8px", flexShrink: 0,
                    fontFamily: F.mono, fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase",
                    border: `1.5px solid ${status.color}`, color: status.color, fontWeight: 700,
                  }}>
                    {status.label}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {openItem && (
        <SubmissionDetailModal
          submission={openItem}
          onClose={() => setOpenId(null)}
          onAfterAction={() => { setOpenId(null); refresh(); }}
        />
      )}
    </div>
  );
}

/* ============================================================
   SubmissionDetailModal — admin view of a single submission with
   the full payload contents + Approve / Reject actions.
   ============================================================ */
function SubmissionDetailModal({ submission, onClose, onAfterAction }) {
  const { t, locale } = useI18n();
  const { isMobile } = useViewport();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmingReject, setConfirmingReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(locale, { month: "short", day: "2-digit", year: "numeric" });
  };

  const payload = submission.payload || {};

  const renderItemsList = (list, label) => {
    if (!list || list.length === 0) return null;
    return (
      <div style={{ marginTop: 14 }}>
        <div style={{ marginBottom: 8, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
          {label} ({list.length})
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {list.map((it, idx) => (
            <div key={it.id || idx} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "8px 12px",
              borderBottom: `1px solid ${C.line}`,
            }}>
              <span style={{ flex: 1, minWidth: 0, fontFamily: F.body, fontSize: 14, color: C.ink }}>
                {it.name}
              </span>
              {it.category && (
                <span style={{ fontFamily: F.mono, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: C.muted }}>
                  {it.category}
                </span>
              )}
              {it.weight && (
                <span style={{ fontFamily: F.mono, fontSize: 11, color: C.muted, fontWeight: 600 }}>
                  {it.weight}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderContents = () => {
    if (submission.kind === "kit") {
      const kit = payload.kit || {};
      const items = payload.items || kit.items || [];
      return (
        <>
          <div style={{ marginTop: 14, padding: 12, background: C.paperDeep, borderLeft: `3px solid ${C.forest}` }}>
            <div style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>KIT</div>
            <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 18, fontWeight: 700 }}>{kit.name || submission.title}</div>
            {kit.category && (
              <div style={{ marginTop: 4, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                {kit.category}
              </div>
            )}
          </div>
          {renderItemsList(items, t("admin.itemsInKit"))}
        </>
      );
    }
    if (submission.kind === "category") {
      const cat = payload.category || {};
      const items = payload.items || [];
      return (
        <>
          <div style={{ marginTop: 14, padding: 12, background: C.paperDeep, borderLeft: `3px solid ${C.forest}` }}>
            <div style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>CATEGORY</div>
            <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 18, fontWeight: 700 }}>{cat.name || submission.title}</div>
          </div>
          {renderItemsList(items, t("admin.itemsInCategory"))}
        </>
      );
    }
    if (submission.kind === "trip") {
      const pl = payload.packlist || {};
      const kitsList = payload.kits || [];
      const itemsList = payload.items || [];
      return (
        <>
          <div style={{ marginTop: 14, padding: 12, background: C.paperDeep, borderLeft: `3px solid ${C.forest}` }}>
            <div style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>TRIP / PACKLIST</div>
            <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 18, fontWeight: 700 }}>{pl.name || submission.title}</div>
            {pl.dest && <div style={{ marginTop: 4, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>📍 {pl.dest}</div>}
            {pl.date && <div style={{ marginTop: 2, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>📅 {pl.date}</div>}
          </div>
          {kitsList.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ marginBottom: 8, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
                {t("admin.kitsInTrip")} ({kitsList.length})
              </div>
              {kitsList.map((k, idx) => (
                <div key={k.id || idx} style={{ marginBottom: 12 }}>
                  <div style={{ fontFamily: F.display, fontSize: 16, fontWeight: 700 }}>{k.name}</div>
                  {k.items && k.items.length > 0 && (
                    <div style={{ paddingLeft: 12 }}>
                      {k.items.map((it, ii) => (
                        <div key={it.id || ii} style={{ padding: "4px 0", fontFamily: F.body, fontSize: 13, color: C.inkSoft }}>
                          • {it.name}{it.weight ? ` — ${it.weight}` : ""}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {renderItemsList(itemsList, t("admin.standaloneItems"))}
        </>
      );
    }
    return null;
  };

  const handleApprove = async () => {
    setBusy(true);
    setError("");
    const result = await supabaseService.setSubmissionStatus(submission.id, "approved");
    setBusy(false);
    if (result.error) { setError(result.error); return; }
    onAfterAction();
  };

  const handleReject = async () => {
    setBusy(true);
    setError("");
    const result = await supabaseService.setSubmissionStatus(submission.id, "rejected", rejectReason.trim() || null);
    setBusy(false);
    if (result.error) { setError(result.error); return; }
    onAfterAction();
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(26,36,33,0.55)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        width: "100%", maxWidth: 720, maxHeight: "92vh", overflowY: "auto",
        background: C.paper, border: `1.5px solid ${C.ink}`, padding: isMobile ? 18 : 28,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Coord>{submission.kind.toUpperCase()}  ·  {submission.activity || t("admin.noActivity")}</Coord>
            <h3 style={{ margin: "4px 0 0", fontFamily: F.display, fontSize: isMobile ? 22 : 28, fontWeight: 700, letterSpacing: "-0.02em" }}>
              {submission.title}<span style={{ color: C.rust }}>.</span>
            </h3>
            <div style={{ marginTop: 4, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
              @{submission.publisher_username}{submission.publisher_region ? ` · ${submission.publisher_region}` : ""} · {fmtDate(submission.created_at)}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: C.ink, padding: 4 }} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        {submission.description && (
          <div style={{ padding: 12, background: C.paperDeep, borderLeft: `3px solid ${C.ochre}`, fontFamily: F.body, fontSize: 14, fontStyle: "italic", color: C.ink, lineHeight: 1.5 }}>
            "{submission.description}"
          </div>
        )}

        <div style={{ marginTop: 14, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
          {t("admin.currentStatus")}: <span style={{ color: submission.status === "approved" ? C.forest : submission.status === "rejected" ? C.rust : C.muted }}>{submission.status}</span>
        </div>
        {submission.rejection_reason && (
          <div style={{ marginTop: 6, fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.rust }}>
            {t("admin.rejectionReason")}: {submission.rejection_reason}
          </div>
        )}

        {renderContents()}

        {error && (
          <div style={{ marginTop: 14, padding: 12, background: C.paperDeep, border: `1.5px solid ${C.rust}`, color: C.rust, fontFamily: F.body, fontSize: 13 }}>
            ⚠ {error}
          </div>
        )}

        {confirmingReject ? (
          <div style={{ marginTop: 18, padding: 14, background: C.paperDeep, border: `1.5px dashed ${C.rust}` }}>
            <div style={{ marginBottom: 8, fontFamily: F.mono, fontSize: 10, color: C.rust, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
              {t("admin.rejectingTitle")}
            </div>
            <div style={{ marginBottom: 10, fontFamily: F.body, fontSize: 13, color: C.inkSoft }}>
              {t("admin.rejectingHint")}
            </div>
            <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
              placeholder={t("admin.rejectReasonPh")} rows={3}
              style={{
                width: "100%", padding: "10px 12px", background: C.paper, border: `1px solid ${C.line}`,
                outline: "none", fontFamily: F.body, fontSize: 14, color: C.ink, resize: "vertical",
              }} />
            <div style={{ marginTop: 10, display: "flex", gap: 6, justifyContent: "flex-end", flexDirection: isMobile ? "column-reverse" : "row" }}>
              <Btn variant="ghost" icon={X} onClick={() => setConfirmingReject(false)} fullWidth={isMobile} disabled={busy}>{t("common.cancel")}</Btn>
              <Btn variant="rust" icon={Check} onClick={handleReject} fullWidth={isMobile} disabled={busy}>{t("admin.confirmReject")}</Btn>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 18, display: "flex", gap: 8, justifyContent: "flex-end", flexDirection: isMobile ? "column-reverse" : "row" }}>
            {submission.status !== "rejected" && (
              <Btn variant="ghost" icon={X} onClick={() => setConfirmingReject(true)} fullWidth={isMobile} disabled={busy}>{t("admin.btnReject")}</Btn>
            )}
            {submission.status !== "approved" && (
              <Btn variant="rust" icon={Check} onClick={handleApprove} fullWidth={isMobile} disabled={busy}>{t("admin.btnApprove")}</Btn>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   MySubmissions — shown inside Settings. Lists this user's
   library submissions with status (pending/approved/rejected),
   and lets them delete their own.
   ============================================================ */
function MySubmissions({ currentUser }) {
  const { t, locale } = useI18n();
  const { isMobile } = useViewport();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmingId, setConfirmingId] = useState(null);
  // Admin overlay — only available to users with is_admin=true on their profile
  const [adminReviewOpen, setAdminReviewOpen] = useState(false);
  const isAdmin = !!currentUser?.is_admin;

  const refresh = async () => {
    if (!currentUser?.id) { setItems([]); setLoading(false); return; }
    setLoading(true);
    const list = await supabaseService.fetchMySubmissions(currentUser.id);
    setItems(list);
    setLoading(false);
  };

  useEffect(() => { refresh(); }, [currentUser?.id]);

  const handleDelete = async (id) => {
    const result = await supabaseService.deleteSubmission(id);
    if (!result.error) refresh();
    setConfirmingId(null);
  };

  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(locale, { month: "short", day: "2-digit", year: "numeric" });
  };

  const statusInfo = (s) => {
    if (s === "approved") return { label: t("lib.subStatusApproved"), color: C.forest };
    if (s === "rejected") return { label: t("lib.subStatusRejected"), color: C.rust };
    return { label: t("lib.subStatusPending"), color: C.muted };
  };

  return (
    <>
    <SettingGroup title={t("lib.mySubsTitle")} num="03">
      {/* Admin-only button to enter the full review screen */}
      {isAdmin && (
        <div style={{ marginBottom: 14 }}>
          <Btn variant="rust" icon={Globe} onClick={() => setAdminReviewOpen(true)}>
            {t("admin.reviewBtn")}
          </Btn>
        </div>
      )}
      {!currentUser?.id ? (
        <div style={{ padding: 12, fontFamily: F.body, fontSize: 13, color: C.muted, fontStyle: "italic" }}>
          Sign in to manage your library submissions.
        </div>
      ) : loading ? (
        <div style={{ padding: 12, fontFamily: F.body, fontSize: 13, color: C.muted, fontStyle: "italic" }}>Loading...</div>
      ) : items.length === 0 ? (
        <div style={{ padding: 16, background: C.paperDeep, border: `1px dashed ${C.line}`, textAlign: "center" }}>
          <div style={{ fontFamily: F.display, fontStyle: "italic", fontSize: 16, color: C.inkSoft }}>{t("lib.mySubsEmpty")}</div>
          <div style={{ marginTop: 4, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase" }}>{t("lib.mySubsEmptyHint")}</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {items.map((s) => {
            const status = statusInfo(s.status);
            const isConfirming = confirmingId === s.id;
            return (
              <div key={s.id} style={{ background: C.paper, border: `1.5px solid ${C.line}`, padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Coord>{s.kind.toUpperCase()}  ·  {s.activity}</Coord>
                    <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1 }}>{s.title}</div>
                    {s.description && (
                      <div style={{ marginTop: 4, fontFamily: F.body, fontSize: 12, fontStyle: "italic", color: C.inkSoft, lineHeight: 1.4 }}>{s.description}</div>
                    )}
                  </div>
                  <span style={{
                    padding: "3px 8px",
                    fontFamily: F.mono,
                    fontSize: 9,
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    border: `1.5px solid ${status.color}`,
                    color: status.color,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}>
                    {status.label}
                  </span>
                </div>

                {s.status === "rejected" && s.rejection_reason && (
                  <div style={{ marginTop: 8, padding: 8, background: C.paperDeep, border: `1px dashed ${C.rust}`, fontFamily: F.body, fontSize: 12, color: C.inkSoft, fontStyle: "italic" }}>
                    {t("lib.subRejectReason", { r: s.rejection_reason })}
                  </div>
                )}

                <div style={{ marginTop: 8, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                  {fmtDate(s.created_at)}
                  {s.status === "approved" && (
                    <> · {s.view_count || 0} views · {s.import_count || 0} imports</>
                  )}
                </div>

                {!isConfirming ? (
                  <div style={{ marginTop: 10 }}>
                    <Btn variant="ghost" icon={Trash2} onClick={() => setConfirmingId(s.id)}>{t("lib.subDelete")}</Btn>
                  </div>
                ) : (
                  <div style={{ marginTop: 10, padding: 10, background: C.paperDeep, border: `1px dashed ${C.rust}` }}>
                    <div style={{ fontFamily: F.body, fontSize: 12, color: C.inkSoft, marginBottom: 8 }}>{t("lib.subDeleteConfirm")}</div>
                    <div style={{ display: "flex", gap: 6, flexDirection: isMobile ? "column-reverse" : "row" }}>
                      <Btn variant="ghost" icon={X} onClick={() => setConfirmingId(null)} fullWidth={isMobile}>{t("share.cancel")}</Btn>
                      <Btn variant="rust" icon={Trash2} onClick={() => handleDelete(s.id)} fullWidth={isMobile}>{t("lib.subDeleteYes")}</Btn>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </SettingGroup>
    {adminReviewOpen && <AdminSubmissionsReview onClose={() => setAdminReviewOpen(false)} />}
    </>
  );
}

/* ============================================================
   LIBRARY — public browse screen showing approved community items.
   Two filter axes (region + activity) plus a kind tab strip.
   ============================================================ */
function Library({
  go,
  currentUser,
  items, setItems,
  kits, setKits,
  categories, setCategories,
  trips, setTrips,
  packlists, setPacklists,
}) {
  const { t, lang } = useI18n();
  const { isMobile } = useViewport();
  const [kind, setKind] = useState("kit");
  const [activity, setActivity] = useState("");
  const [region, setRegion] = useState("");
  const [list, setList] = useState([]);
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openItemId, setOpenItemId] = useState(null);
  const [counts, setCounts] = useState({ kit: 0, category: 0, trip: 0 });

  // Load tab counts on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const all = await supabaseService.fetchLibrary({ limit: 200 });
      if (cancelled) return;
      const c = { kit: 0, category: 0, trip: 0 };
      all.forEach((x) => { c[x.kind] = (c[x.kind] || 0) + 1; });
      setCounts(c);
    })();
    return () => { cancelled = true; };
  }, []);

  // Load list when filters change
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const data = await supabaseService.fetchLibrary({ kind, activity: activity || null, region: region || null });
      if (!cancelled) { setList(data); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [kind, activity, region]);

  // Load activities for filter dropdown
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await supabaseService.fetchActivities();
      if (!cancelled) setActivities(list);
    })();
    return () => { cancelled = true; };
  }, []);

  // Detail view
  if (openItemId) {
    return (
      <div>
        <Header go={go} active="library" />
        <div style={{ padding: padX(isMobile) }}>
          <LibraryDetail
            itemId={openItemId}
            currentUser={currentUser}
            items={items} setItems={setItems}
            kits={kits} setKits={setKits}
            categories={categories} setCategories={setCategories}
            trips={trips} setTrips={setTrips}
            packlists={packlists} setPacklists={setPacklists}
            onBack={() => setOpenItemId(null)}
          />
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <div>
      <Header go={go} active="library" />
      <div style={{ padding: padX(isMobile) }}>
        <div style={{ marginTop: isMobile ? 24 : 40 }}>
          <Coord>{t("libBrowse.section")}</Coord>
          <h1 style={{ margin: "12px 0", fontFamily: F.display, fontSize: "clamp(36px, 6vw, 72px)", fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 0.95 }}>
            {t("libBrowse.titleA")} <span style={{ fontStyle: "italic", color: C.forest }}>{t("libBrowse.titleB")}</span><span style={{ color: C.rust }}>.</span>
          </h1>
          <div style={{ marginTop: 6, fontFamily: F.display, fontStyle: "italic", color: C.inkSoft, fontSize: isMobile ? 15 : 17 }}>
            {t("libBrowse.tagline")}
          </div>
        </div>

        {/* Kind tabs */}
        <div style={{ marginTop: isMobile ? 24 : 36, display: "flex", borderBottom: `1.5px solid ${C.ink}`, overflowX: "auto", scrollbarWidth: "none" }}>
          {[
            ["kit", t("libBrowse.tabKits", { n: counts.kit })],
            ["category", t("libBrowse.tabCategories", { n: counts.category })],
            ["trip", t("libBrowse.tabTrips", { n: counts.trip })],
          ].map(([k, label]) => (
            <button key={k} onClick={() => setKind(k)}
              style={{
                padding: isMobile ? "10px 14px" : "12px 20px",
                border: "none", cursor: "pointer",
                fontFamily: F.mono, fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase",
                fontWeight: 700, background: kind === k ? C.ink : "transparent",
                color: kind === k ? C.paper : C.ink, whiteSpace: "nowrap", flexShrink: 0,
              }}>
              {label}
            </button>
          ))}
        </div>

        {/* Filters: region + activity */}
        <div style={{ marginTop: 16, display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
          <label style={{ flex: "1 1 200px", minWidth: 180 }}>
            <div style={{ marginBottom: 4, fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
              {t("libBrowse.filterRegion")}
            </div>
            <select value={region} onChange={(e) => setRegion(e.target.value)} style={{
              width: "100%", padding: "8px 28px 8px 0", background: "transparent", border: "none",
              borderBottom: `1.5px solid ${C.ink}`, outline: "none", fontFamily: F.body, fontSize: 14, color: C.ink,
              appearance: "none", WebkitAppearance: "none", cursor: "pointer",
              backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%231A2421' stroke-width='1.5' fill='none'/></svg>")`,
              backgroundRepeat: "no-repeat", backgroundPosition: "right 4px center",
            }}>
              <option value="">{t("libBrowse.filterAll")}</option>
              {REGIONS.map((r) => (
                <option key={r.code} value={r.code}>{r.code} — {lang === "es" ? r.labelEs : r.labelEn}</option>
              ))}
            </select>
          </label>
          <label style={{ flex: "1 1 200px", minWidth: 180 }}>
            <div style={{ marginBottom: 4, fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
              {t("libBrowse.filterActivity")}
            </div>
            <select value={activity} onChange={(e) => setActivity(e.target.value)} style={{
              width: "100%", padding: "8px 28px 8px 0", background: "transparent", border: "none",
              borderBottom: `1.5px solid ${C.ink}`, outline: "none", fontFamily: F.body, fontSize: 14, color: C.ink,
              appearance: "none", WebkitAppearance: "none", cursor: "pointer",
              backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%231A2421' stroke-width='1.5' fill='none'/></svg>")`,
              backgroundRepeat: "no-repeat", backgroundPosition: "right 4px center",
            }}>
              <option value="">{t("libBrowse.filterAll")}</option>
              {activities.map((a) => (
                <option key={a.id || a.name} value={a.name}>{a.name}</option>
              ))}
            </select>
          </label>
          {(region || activity) && (
            <Btn variant="ghost" icon={X} onClick={() => { setRegion(""); setActivity(""); }}>
              Clear filters
            </Btn>
          )}
        </div>

        {/* List */}
        <div style={{ marginTop: 24 }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: "center", fontFamily: F.body, fontSize: 14, color: C.muted, fontStyle: "italic" }}>
              Loading...
            </div>
          ) : list.length === 0 ? (
            <div style={{ padding: isMobile ? 32 : 48, textAlign: "center", border: `1.5px dashed ${C.line}`, background: C.paperDeep }}>
              <div style={{ fontFamily: F.display, fontStyle: "italic", fontSize: isMobile ? 20 : 24, color: C.inkSoft }}>
                {region || activity ? t("libBrowse.empty") : t("libBrowse.emptyAll")}
              </div>
              <div style={{ marginTop: 8, fontFamily: F.mono, fontSize: 11, letterSpacing: "0.15em", color: C.muted, textTransform: "uppercase" }}>
                {region || activity ? t("libBrowse.emptyHint", { kind }) : t("libBrowse.emptyAllHint")}
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 16 }}>
              {list.map((it) => (
                <LibraryCard key={it.id} item={it} onOpen={() => setOpenItemId(it.id)} />
              ))}
            </div>
          )}
        </div>
      </div>
      <Footer />
    </div>
  );
}

// One card in the library list
function LibraryCard({ item, onOpen }) {
  const { t, lang } = useI18n();
  const { isMobile } = useViewport();
  const importsLabel = item.import_count === 1
    ? t("libBrowse.imports_one")
    : t("libBrowse.imports_many", { n: item.import_count || 0 });

  return (
    <button onClick={onOpen} style={{
      display: "flex", flexDirection: "column", alignItems: "stretch", textAlign: "left",
      background: C.paper, border: `1.5px solid ${C.ink}`, padding: 16, cursor: "pointer",
      fontFamily: F.body, color: C.ink,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
        <Coord>{item.kind.toUpperCase()}</Coord>
        {item.publisher_region && <RegionBadge code={item.publisher_region} />}
      </div>
      <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05, paddingRight: 4 }}>
        {item.title}
      </div>
      <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
        {item.activity}
      </div>
      {item.description && (
        <div style={{ marginTop: 10, fontFamily: F.body, fontSize: 13, fontStyle: "italic", color: C.inkSoft, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {item.description}
        </div>
      )}
      <div style={{ flex: 1 }} />
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px dashed ${C.line}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
        <span style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em" }}>
          @{item.publisher_username}
        </span>
        <span style={{ fontFamily: F.mono, fontSize: 10, color: C.muted }}>
          {importsLabel}
        </span>
      </div>
    </button>
  );
}

/* ============================================================
   LibraryDetail — full preview of one library item with import.
   ============================================================ */
function LibraryDetail({
  itemId, currentUser,
  items, setItems,
  kits, setKits,
  categories, setCategories,
  trips, setTrips,
  packlists, setPacklists,
  onBack,
}) {
  const { t, locale, lang } = useI18n();
  const { isMobile } = useViewport();
  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportText, setReportText] = useState("");
  const [reportSubmitted, setReportSubmitted] = useState(false);

  // Load item details + bump view counter once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await supabaseService.fetchLibraryItem(itemId);
      if (cancelled) return;
      setItem(data);
      setLoading(false);
      // Increment view count, but only once per session
      if (data) supabaseService.incrementLibraryCount(itemId, "view_count");
    })();
    return () => { cancelled = true; };
  }, [itemId]);

  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(locale, { month: "long", day: "numeric", year: "numeric" });
  };

  // Import flow — adds the entity (and referenced data) into the user's local inventory.
  // Mirrors the inbox import logic but takes the item directly from the library payload.
  const handleImport = async () => {
    if (!item || importing) return;
    setImporting(true);
    const p = item.payload || {};

    if (item.kind === "kit") {
      const incomingItems = p.items || [];
      const remap = {};
      const newItems = incomingItems.map((it) => {
        const newId = uid("it");
        remap[it.id] = newId;
        return { ...it, id: newId, packed: false };
      });
      const newKitId = uid("kit");
      const newKit = {
        ...p.kit,
        id: newKitId,
        itemIds: (p.kit.itemIds || []).map((id) => remap[id]).filter(Boolean),
      };
      setItems([...newItems, ...items]);
      setKits([newKit, ...kits]);
    }

    if (item.kind === "category") {
      const cat = p.category;
      let categoryName = cat.name;
      const exists = categories.find((c) => c.name === cat.name);
      if (!exists) {
        const newCat = { ...cat, id: uid("cat") };
        setCategories([newCat, ...categories]);
      }
      const incomingItems = p.items || [];
      const newItems = incomingItems.map((it) => ({ ...it, id: uid("it"), category: categoryName, packed: false }));
      if (newItems.length) setItems([...newItems, ...items]);
    }

    if (item.kind === "trip") {
      const trip = p.trip || {};
      const newTrip = { ...trip, id: uid("tr") };
      setTrips([newTrip, ...trips]);

      const itemRemap = {};
      const newItems = (p.items || []).map((it) => {
        const newId = uid("it");
        itemRemap[it.id] = newId;
        return { ...it, id: newId, packed: false };
      });
      if (newItems.length) setItems([...newItems, ...items]);

      const kitRemap = {};
      const newKits = (p.kits || []).map((k) => {
        const newId = uid("kit");
        kitRemap[k.id] = newId;
        return { ...k, id: newId, itemIds: (k.itemIds || []).map((id) => itemRemap[id]).filter(Boolean) };
      });
      if (newKits.length) setKits([...newKits, ...kits]);

      if (p.packlist) {
        const newPl = {
          ...p.packlist,
          id: uid("pl"),
          kitIds: (p.packlist.kitIds || []).map((id) => kitRemap[id]).filter(Boolean),
          itemIds: (p.packlist.itemIds || []).map((id) => itemRemap[id]).filter(Boolean),
        };
        setPacklists([newPl, ...packlists]);
      }
    }

    // Bump import counter on the server
    await supabaseService.incrementLibraryCount(itemId, "import_count");

    setImporting(false);
    setImported(true);
  };

  const submitReport = async () => {
    if (!currentUser?.id) return;
    await supabaseService.submitReport({
      libraryItemId: itemId,
      reporterId: currentUser.id,
      reason: reportText,
    });
    setReportSubmitted(true);
  };

  if (loading) {
    return <div style={{ padding: 40, textAlign: "center", fontFamily: F.body, fontStyle: "italic", color: C.muted }}>Loading...</div>;
  }
  if (!item) {
    return (
      <div style={{ padding: 40 }}>
        <button onClick={onBack} style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", padding: "8px 0", marginBottom: 20 }}>
          <ArrowLeft size={14} /> {t("libDetail.back")}
        </button>
        <div style={{ fontFamily: F.display, fontStyle: "italic", fontSize: 22, color: C.inkSoft }}>Item not found.</div>
      </div>
    );
  }

  const p = item.payload || {};
  const refItems = p.items || [];
  const refKits = p.kits || [];
  const packlist = p.packlist || null;

  return (
    <div>
      {/* Header */}
      <div style={{ marginTop: isMobile ? 16 : 24, marginBottom: 24, paddingBottom: 16, borderBottom: `1.5px solid ${C.ink}` }}>
        <button onClick={onBack} style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", padding: "8px 0", marginBottom: 12 }}>
          <ArrowLeft size={14} /> {t("libDetail.back")}
        </button>
        <Coord>{item.kind.toUpperCase()}  ·  {item.activity}</Coord>
        <h2 style={{ margin: "8px 0 8px", fontFamily: F.display, fontSize: isMobile ? 32 : 44, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1 }}>
          {item.title}<span style={{ color: C.rust }}>.</span>
        </h2>
        {item.description && (
          <div style={{ marginTop: 10, fontFamily: F.display, fontStyle: "italic", color: C.inkSoft, fontSize: isMobile ? 15 : 17, lineHeight: 1.5 }}>
            {item.description}
          </div>
        )}
        <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
          <span>{t("libDetail.publishedBy")} <b style={{ color: C.ink }}>@{item.publisher_username}</b></span>
          {item.publisher_region && <RegionBadge code={item.publisher_region} />}
          <span>·  {t("libDetail.publishedOn", { date: fmtDate(item.created_at) })}</span>
        </div>

        {/* Action row */}
        <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap", flexDirection: isMobile ? "column" : "row" }}>
          {!imported ? (
            <Btn variant="rust" icon={Plus} onClick={handleImport} disabled={importing} fullWidth={isMobile}>
              {importing ? t("libDetail.importing") : t("libDetail.import")}
            </Btn>
          ) : (
            <div style={{ padding: "10px 16px", background: C.forestDeep, color: C.paper, fontFamily: F.mono, fontSize: 11, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700 }}>
              ✓ {t("libDetail.imported")}
            </div>
          )}
          <Btn variant="ghost" icon={AlertTriangle} onClick={() => setReportOpen(true)} fullWidth={isMobile}>
            {t("libDetail.report")}
          </Btn>
        </div>
      </div>

      {/* Contents preview */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ marginBottom: 10, paddingBottom: 6, borderBottom: `1px dashed ${C.line}`, fontFamily: F.display, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
          {t("libDetail.contents")}
        </div>

        {item.kind === "kit" && p.kit && (
          <div style={{ background: C.paper, border: `1.5px solid ${C.ink}`, padding: 16 }}>
            <Coord>KIT</Coord>
            <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>{p.kit.name}</div>
            <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
              {refItems.length} {refItems.length === 1 ? "item" : "items"}
            </div>
            {refItems.length > 0 && (
              <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 5 }}>
                {refItems.map((it) => (
                  <span key={it.id} style={{ padding: "3px 8px", fontFamily: F.mono, fontSize: 10, border: `1px solid ${C.ink}`, background: C.paperDeep }}>
                    {it.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {item.kind === "category" && p.category && (
          <div style={{ background: C.paper, border: `1.5px solid ${C.ink}`, padding: 16 }}>
            <Coord>CATEGORY</Coord>
            <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>{p.category.name}</div>
            <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
              {refItems.length} {refItems.length === 1 ? "item included" : "items included"}
            </div>
            {refItems.length > 0 && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                {refItems.map((it) => (
                  <div key={it.id} style={{ padding: "6px 8px", background: C.paperDeep, fontFamily: F.body, fontSize: 13 }}>
                    {it.name} <span style={{ color: C.muted, fontFamily: F.mono, fontSize: 10, marginLeft: 4 }}>· {it.weight}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {item.kind === "trip" && p.trip && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ background: C.paper, border: `1.5px solid ${C.ink}`, padding: 16 }}>
              <Coord>TRIP</Coord>
              <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>{p.trip.name}</div>
              <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                {p.trip.dest}
              </div>
            </div>
            {packlist && (
              <div style={{ background: C.paperDeep, border: `1px dashed ${C.line}`, padding: 14 }}>
                <Coord>PACKLIST</Coord>
                <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 16, fontWeight: 700 }}>{packlist.name}</div>
                {packlist.notes && <div style={{ marginTop: 4, fontFamily: F.body, fontSize: 12, fontStyle: "italic", color: C.inkSoft }}>{packlist.notes}</div>}
              </div>
            )}
            {refKits.length > 0 && (
              <div>
                <div style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 6 }}>{refKits.length} kit{refKits.length === 1 ? "" : "s"}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {refKits.map((k) => (
                    <span key={k.id} style={{ padding: "3px 8px", fontFamily: F.mono, fontSize: 10, border: `1.5px solid ${C.forest}`, color: C.forest, fontWeight: 700 }}>
                      {k.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {refItems.length > 0 && (
              <div>
                <div style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 6 }}>{refItems.length} item{refItems.length === 1 ? "" : "s"}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {refItems.map((it) => (
                    <span key={it.id} style={{ padding: "3px 8px", fontFamily: F.mono, fontSize: 10, border: `1px solid ${C.ink}`, background: C.paperDeep }}>
                      {it.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Report dialog */}
      {reportOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(26,36,33,0.55)", zIndex: 999, display: "flex", alignItems: isMobile ? "flex-end" : "center", justifyContent: "center", padding: isMobile ? 0 : 24 }}
          onClick={() => { setReportOpen(false); setReportText(""); setReportSubmitted(false); }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 480, background: C.paper, border: `1.5px solid ${C.ink}`, padding: isMobile ? 20 : 28 }}>
            {!reportSubmitted ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
                  <h3 style={{ margin: 0, fontFamily: F.display, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>{t("libDetail.reportTitle")}<span style={{ color: C.rust }}>.</span></h3>
                  <button onClick={() => { setReportOpen(false); setReportText(""); }} style={{ width: 32, height: 32, cursor: "pointer", background: "transparent", border: `1.5px solid ${C.ink}`, color: C.ink, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <X size={14} />
                  </button>
                </div>
                <div style={{ marginBottom: 14, fontFamily: F.body, fontSize: 13, color: C.muted, fontStyle: "italic" }}>{t("libDetail.reportSub")}</div>
                <textarea value={reportText} onChange={(e) => setReportText(e.target.value)}
                  placeholder={t("libDetail.reportPh")} rows={4}
                  style={{ width: "100%", padding: "10px 12px", background: "transparent", border: `1px solid ${C.line}`, outline: "none", fontFamily: F.body, fontSize: 14, color: C.ink, resize: "vertical" }} />
                <div style={{ marginTop: 14, display: "flex", gap: 8, flexDirection: isMobile ? "column-reverse" : "row", justifyContent: "flex-end" }}>
                  <Btn variant="ghost" icon={X} onClick={() => { setReportOpen(false); setReportText(""); }} fullWidth={isMobile}>{t("share.cancel")}</Btn>
                  <Btn variant="rust" icon={Check} onClick={submitReport} fullWidth={isMobile}>{t("libDetail.reportSubmit")}</Btn>
                </div>
              </>
            ) : (
              <>
                <h3 style={{ margin: "0 0 10px", fontFamily: F.display, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
                  <span style={{ fontStyle: "italic", color: C.forest }}>Thank you</span><span style={{ color: C.rust }}>.</span>
                </h3>
                <div style={{ marginBottom: 14, fontFamily: F.body, fontSize: 14, color: C.inkSoft }}>{t("libDetail.reportThanks")}</div>
                <Btn variant="rust" icon={Check} onClick={() => { setReportOpen(false); setReportText(""); setReportSubmitted(false); }} fullWidth={isMobile}>{t("libDetail.reportClose")}</Btn>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsScreen({ go, user, resetData, storageStatus, locationEnabled, setLocationEnabled, language, setLanguage, units, setUnits }) {
  const { t } = useI18n();
  const { isMobile } = useViewport();
  const [confirming, setConfirming] = useState(false);
  const [permState, setPermState] = useState("unknown");

  useEffect(() => {
    let cancelled = false;
    if (typeof navigator === "undefined" || !navigator.permissions || !navigator.permissions.query) {
      setPermState("unknown");
      return;
    }
    navigator.permissions.query({ name: "geolocation" }).then((res) => {
      if (cancelled) return;
      setPermState(res.state);
      res.onchange = () => { if (!cancelled) setPermState(res.state); };
    }).catch(() => { if (!cancelled) setPermState("unknown"); });
    return () => { cancelled = true; };
  }, []);

  const onReset = () => {
    if (!confirming) { setConfirming(true); return; }
    resetData();
    setConfirming(false);
  };

  const toggleLocation = () => {
    const next = !locationEnabled;
    setLocationEnabled(next);
    if (next && typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        () => setPermState("granted"),
        (err) => setPermState(err && err.code === 1 ? "denied" : "prompt"),
        { timeout: 8000, maximumAge: 60000, enableHighAccuracy: false }
      );
    }
  };

  const statusLabel =
    storageStatus === "ready" ? t("set.storageReady")
    : storageStatus === "saving" ? t("set.storageSaving")
    : storageStatus === "error" ? t("set.storageError")
    : t("set.storageInit");
  const statusColor =
    storageStatus === "ready" ? C.forest
    : storageStatus === "error" ? C.rust
    : C.muted;

  const locDetail =
    !locationEnabled ? t("set.locOff")
    : permState === "granted" ? t("set.locAllowed")
    : permState === "denied" ? t("set.locBlocked")
    : permState === "prompt" ? t("set.locAwaiting")
    : permState === "unsupported" ? t("set.locUnsupported")
    : t("set.locOn");
  const locColor =
    !locationEnabled ? C.muted
    : permState === "granted" ? C.forest
    : permState === "denied" ? C.rust
    : C.ochre;

  return (
    <div>
      <Header go={go} onBack={() => go("dashboard")} />
      <div style={{ padding: padX(isMobile), maxWidth: 760, margin: "0 auto" }}>
        <div style={{ marginTop: isMobile ? 24 : 40 }}>
          <Coord>{t("set.section")}</Coord>
          <h1 style={{ margin: "12px 0 32px", fontFamily: F.display, fontSize: "clamp(36px, 6vw, 64px)", fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 0.95 }}>
            {t("set.title")}<span style={{ color: C.rust }}>.</span>
          </h1>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 36 : 48 }}>
          <SettingGroup title={t("set.profile")} num="01">
            <SettingRow label={t("set.username")} value={user.username || user.name || t("dash.wayfarer")} />
            <SettingRow label={t("set.region")} value={
              user.region ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <RegionBadge code={user.region} />
                  <span>{regionLabel(user.region, language)}</span>
                </span>
              ) : "—"
            } />
            <SettingRow label={t("set.email")} value={user.email || "wayfarer@pakmondo.co"} />
            <SettingRow label={t("set.memberSince")} value="MAR 2025" />
          </SettingGroup>
          <SettingGroup title={t("set.preferences")} num="02">
            <SettingRow label={t("set.units")} value={
              <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                <div style={{ display: "inline-flex", border: `1.5px solid ${C.ink}` }}>
                  {[["metric", t("set.unitsMetric")], ["imperial", t("set.unitsImperial")]].map(([code, label]) => {
                    const sel = units === code;
                    return (
                      <button
                        key={code}
                        onClick={() => setUnits(code)}
                        style={{
                          padding: "6px 14px",
                          border: "none",
                          cursor: "pointer",
                          fontFamily: F.mono,
                          fontSize: 10,
                          letterSpacing: "0.18em",
                          textTransform: "uppercase",
                          fontWeight: 700,
                          background: sel ? C.ink : "transparent",
                          color: sel ? C.paper : C.ink,
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <span style={{ fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                  {units === "imperial" ? t("set.unitsHintImperial") : t("set.unitsHintMetric")}
                </span>
              </div>
            } />
            <SettingRow label={t("set.notifications")} value={t("set.notificationsValue")} />
            <SettingRow label={t("set.theme")} value={t("set.themeValue")} />
            <SettingRow label={t("set.language")} value={
              <div style={{ display: "inline-flex", border: `1.5px solid ${C.ink}` }}>
                {[["en", "English"], ["es", "Español"]].map(([code, label]) => {
                  const sel = language === code;
                  return (
                    <button
                      key={code}
                      onClick={() => setLanguage(code)}
                      style={{
                        padding: "6px 14px",
                        border: "none",
                        cursor: "pointer",
                        fontFamily: F.mono,
                        fontSize: 10,
                        letterSpacing: "0.18em",
                        textTransform: "uppercase",
                        fontWeight: 700,
                        background: sel ? C.ink : "transparent",
                        color: sel ? C.paper : C.ink,
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            } />
            <SettingRow label={t("set.location")} value={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: locColor, display: "inline-block" }} />
                  <span style={{ color: locColor }}>{locDetail}</span>
                </span>
                <button
                  onClick={toggleLocation}
                  style={{
                    padding: "6px 14px",
                    border: `1.5px solid ${locationEnabled ? C.rust : C.ink}`,
                    background: locationEnabled ? C.rust : "transparent",
                    color: locationEnabled ? C.paper : C.ink,
                    cursor: "pointer",
                    fontFamily: F.mono, fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700,
                  }}
                >
                  {locationEnabled ? t("set.disable") : t("set.allow")}
                </button>
              </span>
            } />
            {locationEnabled && permState === "denied" && (
              <div style={{ marginTop: 12, padding: 12, background: C.paperDeep, border: `1px dashed ${C.rust}`, fontFamily: F.body, fontSize: 13, color: C.inkSoft }}>
                {t("set.locBlockedNote")}
              </div>
            )}
          </SettingGroup>
          <SettingGroup title={t("set.subscription")} num="03">
            <SettingRow label={t("set.plan")} value={t("set.planValue")} />
            <SettingRow label={t("set.renews")} value="03 / 14 / 2026" />
            <SettingRow label={t("set.payment")} value="4242" />
          </SettingGroup>
          <MySubmissions currentUser={user} />
          <SettingGroup title={t("set.data")} num="04">
            <SettingRow label={t("set.storage")} value={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor, display: "inline-block" }} />
                <span style={{ color: statusColor }}>{statusLabel}</span>
              </span>
            } />
            <div style={{ marginTop: 24, padding: 20, background: confirming ? C.paperDeep : "transparent", border: confirming ? `1.5px dashed ${C.rust}` : "none" }}>
              {confirming ? (
                <>
                  <div style={{ fontFamily: F.display, fontSize: 18, fontWeight: 700, marginBottom: 6 }}>{t("set.strikeCamp")}</div>
                  <div style={{ fontFamily: F.body, fontSize: 14, color: C.inkSoft, marginBottom: 16 }}>
                    {t("set.strikeNote")}
                  </div>
                  <div style={{ display: "flex", gap: 12 }}>
                    <Btn variant="rust" icon={Trash2} onClick={onReset}>{t("set.confirmWipe")}</Btn>
                    <Btn variant="ghost" icon={X} onClick={() => setConfirming(false)}>{t("common.cancel")}</Btn>
                  </div>
                </>
              ) : (
                <Btn variant="ghost" icon={Trash2} onClick={onReset}>{t("set.resetData")}</Btn>
              )}
            </div>
          </SettingGroup>
          <div>
            <Btn variant="ghost" icon={LogOut} onClick={async () => { await supabaseService.signOut(); go("welcome"); }}>{t("set.signOut")}</Btn>
          </div>
        </div>
      </div>
      <Footer />
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState("welcome");
  const [user, setUser] = useState({ name: "", email: "", username: "", region: "" });
  // Local registry of usernames already in use. Populated on every signup.
  // Lower-cased for case-insensitive uniqueness.
  const [takenUsernames, setTakenUsernames] = useState([]);
  // Personal data — starts empty; populated from Supabase on login.
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [travelTypes, setTravelTypes] = useState(SEED_TRAVEL_TYPES);
  const [cart, setCart] = useState([]);
  const [trips, setTrips] = useState([]);
  const [kits, setKits] = useState([]);
  const [packlists, setPacklists] = useState([]);
  const [inbox, setInbox] = useState([]);
  const [locationEnabled, setLocationEnabled] = useState(false);
  const [inventoryFilter, setInventoryFilter] = useState(null);
  const [language, setLanguage] = useState("en");
  const [units, setUnits] = useState("metric"); // "metric" | "imperial"
  const [loaded, setLoaded] = useState(false);
  const [storageStatus, setStorageStatus] = useState("init");
  // Tracks whether we've completed the initial Supabase fetch for the
  // signed-in user. Until true, no save-back happens (otherwise we'd
  // overwrite the server data with empty arrays on first paint).
  const [personalDataLoaded, setPersonalDataLoaded] = useState(false);
  // Sync error banner — shown at top of app when a save to Supabase fails
  const [syncError, setSyncError] = useState(null);

  // Load from local store on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Plain localStorage (instead of artifact-only window.storage)
      if (typeof window === "undefined" || !window.localStorage) {
        if (!cancelled) { setStorageStatus("error"); setLoaded(true); }
        return;
      }
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (cancelled) return;
        if (raw) {
          try {
            const data = JSON.parse(raw);
            // ONLY non-personal-data state is restored from localStorage.
            // Personal data (items, categories, kits, packlists, cart) lives
            // in Supabase and is loaded separately when the user signs in.
            if (data.user) setUser({ name: "", email: "", username: "", region: "", ...data.user });
            if (Array.isArray(data.takenUsernames)) setTakenUsernames(data.takenUsernames);
            if (Array.isArray(data.travelTypes)) setTravelTypes(data.travelTypes);
            if (Array.isArray(data.inbox)) setInbox(data.inbox);
            if (typeof data.locationEnabled === "boolean") setLocationEnabled(data.locationEnabled);
            if (data.language === "en" || data.language === "es") setLanguage(data.language);
            if (data.units === "metric" || data.units === "imperial") setUnits(data.units);
          } catch (e) {
            // corrupted JSON — ignore
          }
        }
        if (!cancelled) { setStorageStatus("ready"); setLoaded(true); }
      } catch (e) {
        if (!cancelled) { setStorageStatus("ready"); setLoaded(true); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // === SUPABASE: restore session on mount, fetch inbox ===
  useEffect(() => {
    let cancelled = false;

    // Special case: if the URL contains ?reset=true OR a recovery token from
    // Supabase's email link, route to the reset screen FIRST (before normal
    // session restoration kicks in). The Supabase auth client picks up the
    // recovery hash automatically and creates a temporary session that
    // updateUser({ password }) can use.
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      const hash = window.location.hash || "";
      if (url.searchParams.get("reset") === "true" || hash.includes("type=recovery")) {
        setScreen("reset");
        // Clean the URL so a refresh doesn't re-trigger
        if (window.history?.replaceState) {
          window.history.replaceState({}, "", window.location.pathname);
        }
      }
    }

    (async () => {
      const session = await supabaseService.getSession();
      if (cancelled || !session) return;
      // User has an active Supabase session — log them in to the app
      setUser({
        id: session.user.id,
        name: session.profile?.name || "",
        email: session.user.email || "",
        username: session.profile?.username || "",
        region: session.profile?.region || "",
        is_admin: !!session.profile?.is_admin,
      });
      // If we're on welcome/login/signup screen, jump to dashboard.
      // BUT: don't override "reset" — we need to stay there even with a session.
      setScreen((s) => (s === "welcome" || s === "login" || s === "signup") ? "dashboard" : s);
    })();
    return () => { cancelled = true; };
  }, []);

  // === SUPABASE: sync inbox from server whenever user signs in or changes ===
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const remoteShares = await supabaseService.fetchInbox(user.id);
      if (cancelled) return;
      // Merge: keep any local-only fallback shares (with id starting "sh-" or "in-")
      // and replace the rest with remote.
      setInbox((prev) => {
        const localOnly = prev.filter((s) => String(s.id).startsWith("sh-") || String(s.id).startsWith("in-"));
        // Map Supabase shares to local shape
        const mapped = remoteShares.map((r) => ({
          id: r.id,
          fromUsername: r.from_username,
          fromName: r.from_name,
          fromRegion: r.from_region,
          toUsername: r.to_username,
          kind: r.kind,
          mode: r.mode,
          sentAt: r.sent_at,
          status: r.status,
          payload: r.payload,
          importedAt: r.imported_at,
        }));
        return [...mapped, ...localOnly];
      });
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  // === SUPABASE: load personal data (items/cats/kits/packlists/cart) on login ===
  // Runs whenever the user changes (e.g. after login). Until this finishes,
  // personalDataLoaded is false — so the auto-sync effect below doesn't fire.
  // IMPORTANT: We verify the user has a real authenticated Supabase session
  // BEFORE loading. Without this, a cached user from localStorage could trigger
  // an unauthenticated query, which RLS would silently return 0 rows for.
  useEffect(() => {
    if (!user?.id) {
      // No user signed in — clear personal data and mark as loaded
      setItems([]);
      setCategories([]);
      setKits([]);
      setPacklists([]);
      setCart([]);
      setPersonalDataLoaded(false);
      return;
    }
    let cancelled = false;
    setPersonalDataLoaded(false);
    (async () => {
      try {
        // First check: do we actually have a live Supabase session?
        // If the user object came from localStorage cache but Supabase has no
        // session (e.g. iOS Safari purged sessionStorage), the load query
        // would return empty due to RLS. Bail out and prompt re-login instead.
        const { data: sessionData } = await supabase.auth.getSession();
        if (cancelled) return;
        if (!sessionData?.session?.user?.id) {
          // No live session — clear cached user so they re-login
          setUser({ name: "", email: "", username: "", region: "" });
          setSyncError("Session expired. Please sign in again to see your data.");
          setPersonalDataLoaded(true);
          return;
        }
        // Session exists but for a different user? sync our user state to it.
        if (sessionData.session.user.id !== user.id) {
          // Reload from the actual session user — let the user effect re-run
          return;
        }
        const data = await supabaseService.loadPersonalData(user.id);
        if (cancelled) return;
        setItems(data.items || []);
        setCategories(data.categories || []);
        setKits(data.kits || []);
        setPacklists(data.packlists || []);
        setCart(data.cart || []);
        setPersonalDataLoaded(true);
      } catch (e) {
        if (!cancelled) {
          setSyncError("Failed to load your data. Some changes may not be visible.");
          setPersonalDataLoaded(true); // unblock UI even on error
        }
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  // Persist non-personal preferences to localStorage. Personal data
  // (items/categories/kits/packlists/cart) is synced to Supabase instead.
  useEffect(() => {
    if (!loaded) return;
    if (typeof window === "undefined" || !window.localStorage) return;
    setStorageStatus("saving");
    const payload = JSON.stringify({ user, takenUsernames, travelTypes, inbox, locationEnabled, language, units });
    try {
      window.localStorage.setItem(STORAGE_KEY, payload);
      setStorageStatus("ready");
    } catch (e) {
      setStorageStatus("error");
    }
  }, [loaded, user, takenUsernames, travelTypes, inbox, locationEnabled, language, units]);

  const resetData = async () => {
    // Sign out from Supabase if we're authenticated
    try { await supabaseService.signOut(); } catch (e) { /* ignore */ }
    setUser({ name: "", email: "", username: "", region: "" });
    setTakenUsernames([]);
    setItems([]);
    setCategories([]);
    setTravelTypes(SEED_TRAVEL_TYPES);
    setCart([]);
    setTrips([]);
    setKits([]);
    setPacklists([]);
    setInbox([]);
    setPersonalDataLoaded(false);
    setLocationEnabled(false);
    setLanguage("en");
    setUnits("metric");
    setScreen("welcome");
    if (typeof window !== "undefined" && window.localStorage) {
      try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    }
  };

  const go = (next, opts = {}) => {
    if (next === "inventory") {
      setInventoryFilter(opts.filter || null);
    }
    setScreen(next);
  };
  const clearInventoryFilter = () => setInventoryFilter(null);

  // ============== SUPABASE SYNC WRAPPERS ==============
  // These wrap the raw setItems/setCategories/setKits/setPacklists/setCart
  // setters. When a child component calls one of these, we:
  //   1) Update local state immediately (optimistic — UI feels instant)
  //   2) Diff the old and new arrays to detect adds/updates/deletes
  //   3) Push each change to Supabase in the background
  //   4) If a Supabase call fails, show a banner but keep the local change
  //
  // This way existing code that does `setItems([...items, newItem])` or
  // `setItems(items.filter(...))` keeps working — we infer the diff.

  // Diff helper: given old[] and new[] arrays of {id, ...}, returns
  // { added, updated, removed } lists. Used to decide what to push to db.
  const diffById = (oldArr, newArr) => {
    const oldMap = new Map((oldArr || []).map((x) => [x.id, x]));
    const newMap = new Map((newArr || []).map((x) => [x.id, x]));
    const added = [];
    const updated = [];
    const removed = [];
    for (const [id, n] of newMap) {
      const o = oldMap.get(id);
      if (!o) added.push(n);
      else if (JSON.stringify(o) !== JSON.stringify(n)) updated.push(n);
    }
    for (const [id, o] of oldMap) {
      if (!newMap.has(id)) removed.push(o);
    }
    return { added, updated, removed };
  };

  // Build a synced setter for any of the personal-data tables. Takes:
  //   - rawSetter: the raw useState setter
  //   - currentArr: the current array (closure captures it)
  //   - upsertFn(entity, userId): supabase upsert
  //   - deleteFn(id): supabase delete
  // Returns a wrapped setter that accepts either a new array or a function.
  const makeSyncedSetter = (rawSetter, currentArr, upsertFn, deleteFn) => {
    return (next) => {
      // Compute the new array (handle both array and updater function forms)
      const newArr = typeof next === "function" ? next(currentArr) : next;
      // Update local state immediately
      rawSetter(newArr);
      // If no user is signed in, don't sync (this happens during signup before auth completes)
      if (!user?.id || !personalDataLoaded) return;
      // Diff and push changes in the background
      const { added, updated, removed } = diffById(currentArr, newArr);
      [...added, ...updated].forEach((entity) => {
        upsertFn(entity, user.id).then((res) => {
          if (res?.error) setSyncError("Save failed: " + res.error);
        });
      });
      removed.forEach((entity) => {
        deleteFn(entity.id).then((res) => {
          if (res?.error) setSyncError("Delete failed: " + res.error);
        });
      });
    };
  };

  // Wrapped setters — these are what gets passed down to all child components
  const setItemsSynced     = makeSyncedSetter(setItems,     items,      supabaseService.upsertItem,     supabaseService.deleteItem);
  const setCategoriesSynced= makeSyncedSetter(setCategories,categories, supabaseService.upsertCategory, supabaseService.deleteCategory);
  const setKitsSynced      = makeSyncedSetter(setKits,      kits,       supabaseService.upsertKit,      supabaseService.deleteKit);
  const setPacklistsSynced = makeSyncedSetter(setPacklists, packlists,  supabaseService.upsertPacklist, supabaseService.deletePacklist);
  const setCartSynced      = makeSyncedSetter(setCart,      cart,       supabaseService.upsertCartLine, supabaseService.deleteCartLine);


  if (!loaded) {
    return (
      <div style={{ minHeight: "100vh", width: "100%", position: "relative", background: C.paper, color: C.ink, fontFamily: F.body, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <TopoBG opacity={0.12} />
        <div style={{ position: "relative", zIndex: 1, textAlign: "center" }}>
          <CompassRose size={56} />
          <div style={{ marginTop: 20, fontFamily: F.display, fontStyle: "italic", fontSize: 22, color: C.inkSoft }}>
            Breaking camp...
          </div>
          <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 11, letterSpacing: "0.18em", color: C.muted, textTransform: "uppercase" }}>
            Loading field journal
          </div>
        </div>
      </div>
    );
  }

  const shareService = buildShareService({
    inbox, setInbox,
    currentUser: user,
    items, kits, categories, packlists, trips,
  });

  const inner =
    screen === "welcome" ? <Welcome go={go} /> :
    screen === "login" ? <Login go={go} setUser={setUser} /> :
    screen === "signup" ? <Signup go={go} setUser={setUser} takenUsernames={takenUsernames} setTakenUsernames={setTakenUsernames} /> :
    screen === "forgot" ? <ForgotPassword go={go} /> :
    screen === "reset" ? <ResetPassword go={go} /> :
    screen === "dashboard" ? <Dashboard go={go} user={user} trips={trips} cart={cart} items={items} packlists={packlists} kits={kits} locationEnabled={locationEnabled} shareService={shareService} /> :
    screen === "inventory" ? <Inventory go={go} items={items} setItems={setItemsSynced} categories={categories} setCategories={setCategoriesSynced} travelTypes={travelTypes} setTravelTypes={setTravelTypes} kits={kits} setKits={setKitsSynced} packlists={packlists} setPacklists={setPacklistsSynced} cart={cart} setCart={setCartSynced} shareService={shareService} currentUser={user} filter={inventoryFilter} clearFilter={clearInventoryFilter} /> :
    screen === "trips" ? <Trips go={go} trips={trips} setTrips={setTrips} travelTypes={travelTypes} setTravelTypes={setTravelTypes} shareService={shareService} currentUser={user} items={items} setItems={setItemsSynced} kits={kits} setKits={setKitsSynced} categories={categories} setCategories={setCategoriesSynced} packlists={packlists} setPacklists={setPacklistsSynced} /> :
    screen === "packlists" ? <Packlists go={go} packlists={packlists} setPacklists={setPacklistsSynced} kits={kits} setKits={setKitsSynced} items={items} setItems={setItemsSynced} categories={categories} setCategories={setCategoriesSynced} travelTypes={travelTypes} setTravelTypes={setTravelTypes} /> :
    screen === "cart" ? <Cart go={go} cart={cart} setCart={setCartSynced} /> :
    screen === "inbox" ? <Inbox go={go} inbox={inbox} setInbox={setInbox} items={items} setItems={setItemsSynced} kits={kits} setKits={setKitsSynced} categories={categories} setCategories={setCategoriesSynced} trips={trips} setTrips={setTrips} packlists={packlists} setPacklists={setPacklistsSynced} shareService={shareService} /> :
    screen === "library" ? <Library go={go} currentUser={user} items={items} setItems={setItemsSynced} kits={kits} setKits={setKitsSynced} categories={categories} setCategories={setCategoriesSynced} trips={trips} setTrips={setTrips} packlists={packlists} setPacklists={setPacklistsSynced} /> :
    screen === "settings" ? <SettingsScreen go={go} user={user} resetData={resetData} storageStatus={storageStatus} locationEnabled={locationEnabled} setLocationEnabled={setLocationEnabled} language={language} setLanguage={setLanguage} units={units} setUnits={setUnits} /> :
    <Welcome go={go} />;

  const i18nValue = {
    lang: language,
    t: makeT(language),
    locale: language === "es" ? "es-ES" : "en-US",
    units,
  };

  return (
    <I18nContext.Provider value={i18nValue}>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; }
        button { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
        input, select, textarea { -webkit-tap-highlight-color: transparent; }
        /* Hide horizontal scrollbar on tab strips while keeping touch-scroll */
        ::-webkit-scrollbar { height: 0; width: 0; }
      `}</style>
      <div style={{ minHeight: "100vh", width: "100%", position: "relative", background: C.paper, color: C.ink, fontFamily: F.body, overflowX: "hidden" }}>
        {syncError && (
          <div style={{
            position: "fixed", top: 0, left: 0, right: 0, zIndex: 2000,
            padding: "10px 16px",
            background: C.rust, color: C.paper,
            fontFamily: F.mono, fontSize: 12, letterSpacing: "0.06em",
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
          }}>
            <span>⚠ {syncError}</span>
            <button onClick={() => setSyncError(null)} style={{ background: "transparent", border: `1px solid ${C.paper}`, color: C.paper, padding: "4px 10px", cursor: "pointer", fontFamily: F.mono, fontSize: 11 }}>
              Dismiss
            </button>
          </div>
        )}
        {inner}
      </div>
    </I18nContext.Provider>
  );
}
