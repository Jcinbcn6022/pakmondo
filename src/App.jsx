import React, { useState, useEffect, createContext, useContext } from "react";
import {
  Compass, Backpack, MapPin, Settings, ShoppingCart,
  ArrowLeft, Plus, Check, X, ChevronRight, User, Lock, Mail, CreditCard,
  Tag, Layers, Globe, Calendar, Trash2, LogOut, Map as MapIcon, Pencil,
  Tent, Snowflake, Waves, TreePine, Flame, Mountain, AlertTriangle, Menu
} from "lucide-react";
import { createClient } from "@supabase/supabase-js";

// === SUPABASE CLIENT ===
// Connects to your Supabase project. The publishable/anon key is safe to ship
// in client code — Row Level Security policies in the database control what
// each user can actually access.
//
// Using sessionStorage (not localStorage) so the user is logged out when the
// browser tab closes. Change to localStorage to keep them logged in.
const SUPABASE_URL = "https://cqmdsbxccgxxznnhzoip.supabase.co";
const SUPABASE_KEY = "sb_publishable_yLnqUTGXr7UBkjeVufDliQ_50CQQM8E";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    storage: typeof window !== "undefined" ? window.sessionStorage : undefined,
    persistSession: true,
    autoRefreshToken: true,
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
};

const C = {
  paper: "#EFE7D6",
  paperDeep: "#E3D6B8",
  ink: "#1A2421",
  inkSoft: "#2C3A33",
  forest: "#2D4A3E",
  forestDeep: "#1E3329",
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
    "common.back": "Back",
    "common.cancel": "Cancel",
    "common.add": "Add",
    "common.discard": "Discard",
    "common.save": "Save",
    "common.yes": "Yes",
    "common.no": "No",
    "common.loading": "Breaking camp...",
    "common.loadingSub": "Loading field journal",

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
    "nav.packlists": "Trip/Packlist",
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
    "dash.statTrips": "Active Trips",
    "dash.statTripsSub": "Planned",
    "dash.statInventory": "In Inventory",
    "dash.statInventorySub": "Catalogued",
    "dash.statWeight": "Pack Weight",
    "dash.statWeightSub": "Currently packed",
    "dash.statCart": "Cart",
    "dash.statCartSub": "Items pending",
    "dash.kitTitle": "The kit, by quarters.",
    "dash.navInventory": "Inventory",
    "dash.navInventoryTag": "Items, categories, ADV styles",
    "dash.navTrips": "Trips",
    "dash.navTripsTag": "Plan a new route or revisit the saved",
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
    "inv.colCategory": "Category",
    "inv.colWeight": "Weight",
    "inv.colPacked": "Pkd",
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
    "pl.openBtn": "Open packlist",
    "pl.editBtn": "Edit",
    "pl.deleteBtn": "Delete",
    "pl.confirmDelete": "Delete this packlist? Kits and items in it remain in your inventory.",
    "pl.confirmYes": "Yes, delete",
    "pl.detailKits": "Kits in this packlist",
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
    "trips.newType": "New style",
    "trips.defineType": "Define a new ADV Style",
    "trips.addType": "Add style",
    "trips.fileTrip": "File the trip",
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
    "common.back": "Atrás",
    "common.cancel": "Cancelar",
    "common.add": "Añadir",
    "common.discard": "Descartar",
    "common.save": "Guardar",
    "common.yes": "Sí",
    "common.no": "No",
    "common.loading": "Levantando el campamento...",
    "common.loadingSub": "Cargando el diario de campo",

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
    "nav.packlists": "Viaje/Lista",
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
    "dash.kitTitle": "El equipo, por secciones.",
    "dash.navInventory": "Inventario",
    "dash.navInventoryTag": "Artículos, categorías, estilos ADV",
    "dash.navTrips": "Viajes",
    "dash.navTripsTag": "Planifica una nueva ruta o revisa las guardadas",
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
    "inv.colCategory": "Categoría",
    "inv.colWeight": "Peso",
    "inv.colPacked": "Emp",
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
    "pl.openBtn": "Abrir lista",
    "pl.editBtn": "Editar",
    "pl.deleteBtn": "Borrar",
    "pl.confirmDelete": "¿Borrar esta lista? Los kits y artículos permanecen en tu inventario.",
    "pl.confirmYes": "Sí, borrar",
    "pl.detailKits": "Kits en esta lista",
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
    "trips.newType": "Nuevo estilo",
    "trips.defineType": "Define un nuevo Estilo ADV",
    "trips.addType": "Añadir estilo",
    "trips.fileTrip": "Archivar el viaje",
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
const SEED_TRAVEL_TYPES = [
  { id: "tt-1", name: "Alpine Trek", icon: "mountain", climate: "Cold", days: "5-14" },
  { id: "tt-2", name: "Desert Crossing", icon: "flame", climate: "Hot Arid", days: "3-7" },
  { id: "tt-3", name: "Coastal Kayak", icon: "waves", climate: "Wet Mild", days: "2-10" },
  { id: "tt-4", name: "Polar Expedition", icon: "snow", climate: "Sub-zero", days: "10-30" },
  { id: "tt-5", name: "Jungle Trail", icon: "tree", climate: "Humid Hot", days: "4-12" },
  { id: "tt-6", name: "Urban Layover", icon: "globe", climate: "Variable", days: "1-4" },
];
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
      if (!["kit", "category", "trip"].includes(data.kind)) return null;
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
              <CompassRose size={isMobile ? 26 : 32} />
              <span style={{ fontFamily: F.display, fontSize: isMobile ? 19 : 22, fontWeight: 900, letterSpacing: "-0.02em", color: C.ink, whiteSpace: "nowrap" }}>PakMondo</span>
            </button>
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
                <CompassRose size={26} />
                <span style={{ fontFamily: F.display, fontSize: 19, fontWeight: 900, letterSpacing: "-0.02em", color: C.ink }}>PakMondo</span>
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
      <Coord>{t("footer.fieldEd")}</Coord>
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
          <h1 style={{ fontFamily: F.display, fontWeight: 900, fontSize: "clamp(48px, 13vw, 132px)", letterSpacing: "-0.04em", lineHeight: 0.95, color: C.ink, margin: "0 0 20px 0" }}>
            PakMondo
          </h1>
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
    });
    go("dashboard");
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "32px 20px" }}>
      <div style={{ width: "100%", maxWidth: 440 }}>
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
    card: "",
    exp: "",
    cvc: "",
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
        <div>
          <SectionHeader num="02" label={t("signup.provisions")} right={t("signup.priceLabel")} />
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <Field label={t("signup.cardNumber")} icon={CreditCard} value={form.card} onChange={set("card")} placeholder="4242 4242 4242 4242" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <Field label={t("signup.expiry")} value={form.exp} onChange={set("exp")} placeholder="MM/YY" />
              <Field label={t("signup.cvc")} value={form.cvc} onChange={set("cvc")} placeholder="123" />
            </div>
          </div>
          <div style={{ marginTop: 32, padding: 20, background: C.paperDeep, border: `1px dashed ${C.line}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
              <div style={{ fontFamily: F.display, fontSize: 17 }}>{t("signup.fieldMembership")}</div>
              <div style={{ fontFamily: F.mono, fontWeight: 700, whiteSpace: "nowrap" }}>$9.00 USD</div>
            </div>
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

function Dashboard({ go, user, trips, cart, items, packlists = [], kits = [], locationEnabled }) {
  const { t, locale, lang, units } = useI18n();
  const { isMobile } = useViewport();
  const totalKgRaw = items.filter((i) => i.packed).reduce((s, i) => s + parseKg(i.weight || ""), 0);
  const totalWeight = formatWeightFromKg(totalKgRaw, units);

  const [coords, setCoords] = useState(null);
  const [coordsState, setCoordsState] = useState("idle");

  useEffect(() => {
    if (!locationEnabled) {
      setCoords(null);
      setCoordsState("idle");
      return;
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setCoordsState("unsupported");
      return;
    }
    setCoordsState("pending");
    let cancelled = false;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (cancelled) return;
        setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setCoordsState("ok");
      },
      (err) => {
        if (cancelled) return;
        setCoordsState(err && err.code === 1 ? "denied" : "unavailable");
      },
      { timeout: 8000, maximumAge: 60000, enableHighAccuracy: false }
    );
    return () => { cancelled = true; };
  }, [locationEnabled]);

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

          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(auto-fit, minmax(180px, 1fr))", gap: 1, marginTop: isMobile ? 24 : 32, background: C.line }}>
            <Stat label={t("dash.statTrips")} value={String(trips.length)} sub={t("dash.statTripsSub")} />
            <Stat label={t("dash.statInventory")} value={String(items.length)} sub={t("dash.statInventorySub")} />
            <Stat label={t("dash.statWeight")} value={totalWeight} sub={t("dash.statWeightSub")} />
            <Stat label={t("dash.statCart")} value={String(cart.length)} sub={t("dash.statCartSub")} />
          </div>
          <h2 style={{ marginTop: isMobile ? 48 : 80, marginBottom: isMobile ? 20 : 32, fontFamily: F.display, fontSize: isMobile ? 26 : 32, fontWeight: 700, letterSpacing: "-0.02em" }}>{t("dash.kitTitle")}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 1, background: C.line }}>
            <NavCard num="01" title={t("dash.navInventory")} tagline={t("dash.navInventoryTag")} icon={Backpack} onClick={() => go("inventory")} dark badge={alerts.length} />
            <NavCard num="02" title={t("dash.navTrips")} tagline={t("dash.navTripsTag")} icon={MapIcon} onClick={() => go("trips")} />
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
                      <div style={{ marginTop: 4, fontFamily: F.display, fontSize: isMobile ? 18 : 20, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1 }}>
                        {p.name}
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

function AddCategoryForm({ onAdd, onCancel }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const save = () => { if (!name.trim()) return; onAdd({ name: name.trim() }); };
  return (
    <AddPanel title={t("form.catTitle")} onSave={save} onCancel={onCancel} saveLabel={t("form.fileCategory")}>
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

function ItemsView({ items, onToggle, onDelete, emptyLabel, emptyHint }) {
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

  // ---------- MOBILE: stacked card layout ----------
  if (isMobile) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map((it, idx) => {
          const expired = it.expiry && isExpired(it.expiry);
          const meta = [];
          if (it.quantity && it.quantity > 1) meta.push(`${t("inv.metaQty")} ${it.quantity}`);
          if (it.size) meta.push(`${t("inv.metaSize")} ${it.size}`);
          if (it.expiry) meta.push(`${t("inv.metaExp")} ${fmtExpiry(it.expiry)}`);
          return (
            <div key={it.id} style={{ background: C.paper, border: `1.5px solid ${C.ink}`, padding: 14, display: "flex", gap: 12, alignItems: "stretch" }}>
              {/* Pack toggle on the left */}
              <button
                onClick={() => onToggle(it.id)}
                style={{
                  width: 44, minWidth: 44,
                  cursor: "pointer",
                  background: it.packed ? C.forest : "transparent",
                  border: `1.5px solid ${it.packed ? C.forest : C.ink}`,
                  color: C.paper,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  alignSelf: "stretch",
                }}
                aria-label="Pack toggle"
              >
                {it.packed && <Check size={20} strokeWidth={3} />}
              </button>

              {/* Center: name + meta + chips */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.15em" }}>
                  {String(idx + 1).padStart(3, "0")}
                </div>
                <div style={{ marginTop: 2, fontFamily: F.display, fontSize: 17, fontWeight: 600, lineHeight: 1.2, wordBreak: "break-word" }}>
                  {it.name}
                </div>
                <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  <span style={{ padding: "2px 6px", fontFamily: F.mono, fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", border: `1px solid ${C.ink}`, fontWeight: 700 }}>
                    {tOrLiteral(lang, "cat", it.category)}
                  </span>
                  <span style={{ fontFamily: F.mono, fontSize: 11, color: C.inkSoft, fontWeight: 700 }}>{formatWeight(it.weight, units)}</span>
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
                  <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.05em" }}>
                    {meta.join("  /  ")}
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
      <div style={{ display: "grid", gridTemplateColumns: "60px 2fr 1fr 1fr 60px 60px", padding: "12px 24px", background: C.ink, color: C.paper, fontFamily: F.mono, fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase" }}>
        <div>{t("inv.colNum")}</div><div>{t("inv.colItem")}</div><div>{t("inv.colCategory")}</div><div>{t("inv.colWeight")}</div><div style={{ textAlign: "right" }}>{t("inv.colPacked")}</div><div></div>
      </div>
      {items.map((it, idx) => {
        const expired = it.expiry && isExpired(it.expiry);
        const meta = [];
        if (it.quantity && it.quantity > 1) meta.push(`${t("inv.metaQty")} ${it.quantity}`);
        if (it.size) meta.push(`${t("inv.metaSize")} ${it.size}`);
        if (it.expiry) meta.push(`${t("inv.metaExp")} ${fmtExpiry(it.expiry)}`);
        return (
          <div key={it.id} style={{ display: "grid", gridTemplateColumns: "60px 2fr 1fr 1fr 60px 60px", padding: "16px 24px", alignItems: "center", borderTop: idx === 0 ? "none" : `1px dashed ${C.line}` }}>
            <div style={{ fontFamily: F.mono, fontSize: 12, color: C.muted }}>{String(idx + 1).padStart(3, "0")}</div>
            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontFamily: F.display, fontSize: 18, fontWeight: 500 }}>{it.name}</span>
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
            </div>
            <div><span style={{ padding: "4px 8px", fontFamily: F.mono, fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", border: `1px solid ${C.ink}` }}>{tOrLiteral(lang, "cat", it.category)}</span></div>
            <div style={{ fontFamily: F.mono, fontSize: 13 }}>{formatWeight(it.weight, units)}</div>
            <div style={{ textAlign: "right" }}>
              <button onClick={() => onToggle(it.id)}
                style={{ width: 28, height: 28, cursor: "pointer", background: it.packed ? C.forest : "transparent", border: `1.5px solid ${it.packed ? C.forest : C.ink}`, color: C.paper, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                aria-label="Pack toggle">
                {it.packed && <Check size={14} strokeWidth={3} />}
              </button>
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

function CategoriesView({ categories, items, kits, onDelete, onOpen, onShare, onPublish }) {
  const { t, lang } = useI18n();
  const { isMobile } = useViewport();
  if (categories.length === 0) return <EmptyState label={t("inv.emptyCats")} hint={t("inv.emptyCatsHint")} />;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 1, background: C.line }}>
      {categories.map((c, idx) => {
        const Icon = iconFor(c.icon);
        const itemCount = items.filter((it) => it.category === c.name).length;
        const kitCount = kits.filter((k) => k.category === c.name).length;
        const itemsLabel = itemCount === 1 ? t("catDetail.itemsCount_one") : t("catDetail.itemsCount_many", { n: itemCount });
        const kitsLabel = kitCount === 1 ? t("catDetail.kitsCount_one") : t("catDetail.kitsCount_many", { n: kitCount });
        return (
          <div
            key={c.id}
            style={{
              padding: 20,
              background: idx % 2 === 0 ? C.paper : C.paperDeep,
              minHeight: 200,
              position: "relative",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {/* Top-right action stack: share + publish + delete */}
            <div style={{ position: "absolute", top: 12, right: 12, display: "flex", flexDirection: "column", gap: 4, zIndex: 2 }}>
              {onShare && (
                <button
                  onClick={() => onShare(c)}
                  style={{ width: 34, height: 34, cursor: "pointer", background: C.paperDeep, border: `1px solid ${C.ink}`, color: C.ink, display: "flex", alignItems: "center", justifyContent: "center" }}
                  aria-label={t("share.btn")}
                  title={t("share.btn")}>
                  <ChevronRight size={14} style={{ transform: "rotate(-45deg)" }} />
                </button>
              )}
              {onPublish && (
                <button
                  onClick={() => onPublish(c)}
                  style={{ width: 34, height: 34, cursor: "pointer", background: C.paperDeep, border: `1px solid ${C.forest}`, color: C.forest, display: "flex", alignItems: "center", justifyContent: "center" }}
                  aria-label={t("lib.publishBtn")}
                  title={t("lib.publishBtn")}>
                  <Globe size={14} />
                </button>
              )}
              <button
                onClick={() => onDelete(c.id)}
                style={{ width: 34, height: 34, cursor: "pointer", background: C.paperDeep, border: `1px solid ${C.rust}`, color: C.rust, display: "flex", alignItems: "center", justifyContent: "center" }}
                aria-label="Delete category"
              >
                <Trash2 size={14} />
              </button>
            </div>

            {/* Icon, name, counts */}
            <Icon size={26} strokeWidth={1.4} color={C.forest} />
            <div style={{ marginTop: 24, fontFamily: F.display, fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1, paddingRight: 40 }}>
              {tOrLiteral(lang, "cat", c.name)}
            </div>
            <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
              {itemsLabel}{kitCount > 0 ? `  /  ${kitsLabel}` : ""}
            </div>

            {/* Spacer + explicit OPEN button at the bottom */}
            <div style={{ flex: 1 }} />
            <div style={{ marginTop: 16 }}>
              <Btn
                variant="rust"
                icon={ChevronRight}
                onClick={() => onOpen(c)}
                fullWidth={true}
              >
                {t("catDetail.openCategory")}
              </Btn>
            </div>
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

function AddKitForm({ categories, onAdd, onCancel, defaultCategory }) {
  const { t, lang } = useI18n();
  const { isMobile } = useViewport();
  const [name, setName] = useState("");
  const [category, setCategory] = useState(defaultCategory || "");
  const save = () => {
    if (!name.trim()) return;
    onAdd({ name: name.trim(), category: category || null, itemIds: [] });
  };
  return (
    <AddPanel title={t("kit.formTitle")} onSave={save} onCancel={onCancel} saveLabel={t("kit.fileKit")}>
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
    </AddPanel>
  );
}

function KitCard({ kit, items, categories, onUpdate, onDelete, onShare, onPublish }) {
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
          <div style={{ marginTop: 4, fontFamily: F.display, fontSize: isMobile ? 22 : 26, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05 }}>{kit.name}</div>
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

function KitsView({ kits, items, categories, onUpdateKit, onDeleteKit, onShareKit, onPublishKit }) {
  const { t } = useI18n();
  if (kits.length === 0) return <EmptyState label={t("kit.empty")} hint={t("kit.emptyHint")} />;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 16 }}>
      {kits.map((kit) => (
        <KitCard key={kit.id} kit={kit} items={items} categories={categories} onUpdate={onUpdateKit} onDelete={onDeleteKit} onShare={onShareKit ? () => onShareKit(kit) : null} onPublish={onPublishKit ? () => onPublishKit(kit) : null} />
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
            defaultCategory={category.name}
            onAdd={handleAddKit}
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
    if (!activity.trim()) return t("lib.activityRequired");
    if (!description.trim()) return t("lib.descriptionRequired");
    return null;
  };

  // Build the payload to publish — same shape as ShareDialog uses
  const submit = async () => {
    const v = validate();
    if (v) { setError(v); return; }
    setSubmitting(true);
    setError("");

    // Ensure the activity exists in library_activities
    const activityResult = await supabaseService.ensureActivity(activity, currentUser.id);
    if (activityResult.error) {
      setError(activityResult.error);
      setSubmitting(false);
      return;
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
      activity: activityResult.name,
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
                <Field label={t("lib.fieldActivity")} icon={Mountain} value={activity}
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
                  {t("lib.fieldDescription")}
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
            <Btn variant={adding ? "ghost" : "rust"} icon={adding ? X : Plus} onClick={() => setAdding(!adding)} fullWidth={isMobile}>
              {adding ? t("common.cancel") : addLabel}
            </Btn>
          )}
        </div>
        <div style={{ marginTop: isMobile ? 20 : 32 }}>
          {tab === "items" && <>{adding && <AddItemForm categories={categories} onAdd={addItem} onCancel={() => setAdding(false)} />}<ItemsView items={filteredItems} onToggle={togglePacked} onDelete={deleteItem} emptyLabel={filterActive ? t("inv.emptyFilter") : undefined} emptyHint={filterActive ? t("inv.emptyFilterHint") : undefined} /></>}
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
                />
              </>
            );
          })()}
          {tab === "kits" && <>{adding && <AddKitForm categories={categories} onAdd={addKit} onCancel={() => setAdding(false)} />}<KitsView kits={kits} items={items} categories={categories} onUpdateKit={updateKit} onDeleteKit={deleteKit} onShareKit={(kit) => setSharing({ kind: "kit", entity: kit })} onPublishKit={currentUser?.id ? (kit) => setPublishing({ kind: "kit", entity: kit }) : null} /></>}
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
                <div style={{ marginTop: 4, fontFamily: F.body, fontSize: 13 }}>{tOrLiteral(lang, "tt", tr.type)}</div>
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
            <div style={{ marginTop: 4 }}>{tOrLiteral(lang, "tt", tr.type)}</div>
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
              fontFamily: F.mono, fontSize: 12, color: C.muted,
              transform: isExpanded ? "rotate(0deg)" : "rotate(-90deg)",
              transition: "transform 0.15s",
            }}>▾</span>
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
                  <span style={{ fontFamily: F.mono, fontSize: 14, color: C.muted, transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}>▾</span>
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
                                width: 44, background: "transparent", border: "none", borderLeft: `1px dashed ${C.line}`,
                                cursor: "pointer", color: C.muted,
                                fontFamily: F.mono, fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase",
                                display: "flex", alignItems: "center", justifyContent: "center",
                              }}
                              title={isExpanded ? t("trips.unifiedCollapse") : t("trips.unifiedExpand")}
                              aria-label={isExpanded ? t("trips.unifiedCollapse") : t("trips.unifiedExpand")}
                            >
                              <span style={{ transform: isExpanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }}>▾</span>
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
            <div style={{ marginTop: 4, fontFamily: F.display, fontSize: isMobile ? 22 : 26, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05, paddingRight: 4 }}>
              {p.name}
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

          {/* Trip type chips */}
          <div>
            <div style={{ marginBottom: 10, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
              {t("trips.tripType")}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {travelTypes.map((tt) => {
                const sel = type === tt.name;
                return (
                  <button key={tt.id} onClick={() => setType(sel ? "" : tt.name)}
                    style={{ padding: "6px 12px", border: `1.5px solid ${sel ? C.forest : C.line}`, background: sel ? C.forest : "transparent", color: sel ? C.paper : C.ink, cursor: "pointer", fontFamily: F.body, fontSize: 13 }}>
                    {tOrLiteral(lang, "tt", tt.name)}
                  </button>
                );
              })}
              <button onClick={() => setAddingType(!addingType)}
                style={{ padding: "6px 12px", border: `1.5px dashed ${C.line}`, background: "transparent", color: C.forest, cursor: "pointer", fontFamily: F.mono, fontSize: 11, letterSpacing: "0.12em", fontWeight: 700 }}>
                + {t("common.add")}
              </button>
            </div>
            {addingType && (
              <div style={{ marginTop: 12, padding: 14, background: C.paperDeep, border: `1.5px dashed ${C.line}` }}>
                <Field label="Type name" value={newType.name} onChange={(e) => setNewType({ ...newType, name: e.target.value })} />
                <div style={{ marginTop: 10, display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  <Btn variant="ghost" icon={X} onClick={() => { setAddingType(false); setNewType({ name: "", climate: "", days: "" }); }}>{t("common.cancel")}</Btn>
                  <Btn variant="rust" icon={Check} onClick={saveNewType} disabled={!newType.name.trim()}>{t("common.save")}</Btn>
                </div>
              </div>
            )}
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

      {/* === UNIFIED INVENTORY BROWSER === */}
      <UnifiedInventoryBrowser
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

      {/* === Quick add new — collapsible toolbar for creating new items/kits/categories on the fly === */}
      <div style={{ marginTop: 24, padding: 14, background: C.paperDeep, border: `1.5px dashed ${C.line}` }}>
        <div style={{ marginBottom: 10, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
          {t("trips.unifiedQuickAdd")}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[
            ["item", t("trips.addNewItemInline")],
            ["kit", t("trips.addNewKitInline")],
            ["cat", t("trips.addNewCatInline")],
          ].map(([k, label]) => {
            const active = inlineMode === k;
            return (
              <button key={k} onClick={() => setInlineMode(active ? null : k)}
                style={{
                  padding: "6px 12px",
                  border: `1.5px ${active ? "solid" : "dashed"} ${C.forest}`,
                  background: active ? C.forest : "transparent",
                  color: active ? C.paper : C.forest,
                  cursor: "pointer",
                  fontFamily: F.mono, fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700,
                }}>
                {label}
              </button>
            );
          })}
        </div>

        {/* Inline create forms */}
        {inlineMode === "item" && (
          <div style={{ marginTop: 12, padding: 12, background: C.paper, border: `1px solid ${C.line}` }}>
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
          </div>
        )}
        {inlineMode === "kit" && (
          <div style={{ marginTop: 12, padding: 12, background: C.paper, border: `1px solid ${C.line}` }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
          <div style={{ marginTop: 12, padding: 12, background: C.paper, border: `1px solid ${C.line}` }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <Field label={t("trips.inlineCatName")} value={newCat.name} onChange={(e) => setNewCat({ name: e.target.value })} />
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <Btn variant="ghost" icon={X} onClick={() => { setInlineMode(null); setNewCat({ name: "" }); }}>{t("trips.inlineCancel")}</Btn>
                <Btn variant="rust" icon={Check} onClick={saveInlineCat} disabled={!newCat.name.trim()}>{t("trips.inlineSave")}</Btn>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Action row */}
      <div style={{ marginTop: isMobile ? 28 : 40, display: "flex", gap: 10, flexDirection: isMobile ? "column-reverse" : "row", justifyContent: "space-between", flexWrap: "wrap" }}>
        <Btn variant="ghost" icon={ArrowLeft} onClick={() => setStep(1)} fullWidth={isMobile}>{t("trips.back")}</Btn>
        <Btn onClick={submit} variant="rust" icon={Check} fullWidth={isMobile}>
          {editMode ? t("pl.saveBtn") : t("trips.fileTrip")}
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
              <span style={{ fontFamily: F.mono, fontSize: 14, color: C.muted, transform: itineraryCollapsed ? "rotate(-90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}>▾</span>
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

                {/* Trip type chips */}
                <div>
                  <div style={{ marginBottom: 10, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.18em", textTransform: "uppercase" }}>
                    {t("trips.tripType")}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {travelTypes.map((tt) => {
                      const sel = type === tt.name;
                      return (
                        <button key={tt.id} onClick={() => setType(sel ? "" : tt.name)}
                          style={{ padding: "6px 12px", border: `1.5px solid ${sel ? C.forest : C.line}`, background: sel ? C.forest : "transparent", color: sel ? C.paper : C.ink, cursor: "pointer", fontFamily: F.body, fontSize: 13 }}>
                          {tOrLiteral(lang, "tt", tt.name)}
                        </button>
                      );
                    })}
                    <button onClick={() => setAddingType(!addingType)}
                      style={{ padding: "6px 12px", border: `1.5px dashed ${C.line}`, background: "transparent", color: C.forest, cursor: "pointer", fontFamily: F.mono, fontSize: 11, letterSpacing: "0.12em", fontWeight: 700 }}>
                      + {t("common.add")}
                    </button>
                  </div>
                  {addingType && (
                    <div style={{ marginTop: 12, padding: 14, background: C.paperDeep, border: `1.5px dashed ${C.line}` }}>
                      <Field label="Type name" value={newType.name} onChange={(e) => setNewType({ name: e.target.value })} />
                      <div style={{ marginTop: 10, display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <Btn variant="ghost" icon={X} onClick={() => { setAddingType(false); setNewType({ name: "" }); }}>{t("common.cancel")}</Btn>
                        <Btn variant="rust" icon={Check} onClick={saveNewType} disabled={!newType.name.trim()}>{t("common.save")}</Btn>
                      </div>
                    </div>
                  )}
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

            <UnifiedInventoryBrowser
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

/* Detail view of a single packlist — shows kits with their items + standalone items */
function PacklistDetail({ packlist, kits, items, categories, onBack, onEdit, onDelete, onRemoveItem, onRemoveKit, onRemoveCategory }) {
  const { t, lang, units } = useI18n();
  const { isMobile } = useViewport();
  const [confirming, setConfirming] = useState(false);

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
        <h2 style={{ margin: "8px 0 8px", fontFamily: F.display, fontSize: isMobile ? 32 : 44, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1 }}>
          {packlist.name}<span style={{ color: C.rust }}>.</span>
        </h2>

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

        <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Btn variant="rust" icon={Pencil} onClick={onEdit}>{t("pl.editBtn")}</Btn>
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

      {/* CATEGORIES section (new) — live-linked */}
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: 12 }}>
            {includedCategories.map((c) => {
              const Icon = iconFor(c.icon);
              const itemCount = items.filter((i) => i.category === c.name).length;
              return (
                <div key={c.id} style={{ background: C.paper, border: `1.5px solid ${C.line}`, padding: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                    <Icon size={18} strokeWidth={1.4} color={C.forest} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: F.body, fontSize: 14, fontWeight: 600 }}>{tOrLiteral(lang, "cat", c.name)}</div>
                      <div style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                        {itemCount} {itemCount === 1 ? "item" : "items"}
                      </div>
                    </div>
                  </div>
                  {onRemoveCategory && (
                    <button onClick={() => onRemoveCategory(c.id)}
                      style={{ width: 32, height: 32, background: "transparent", border: `1px solid ${C.rust}`, color: C.rust, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                      title="Remove from this list" aria-label="Remove">
                      <X size={14} />
                    </button>
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 16 }}>
            {includedKits.map((k) => {
              const itemNames = k.itemIds.map((id) => items.find((i) => i.id === id)).filter(Boolean);
              const kitKg = itemNames.reduce((s, i) => s + parseKg(i.weight || ""), 0);
              const kitWeightStr = formatWeightFromKg(kitKg, units);
              return (
                <div key={k.id} style={{ background: C.paper, border: `1.5px solid ${C.ink}`, padding: 16, position: "relative" }}>
                  {onRemoveKit && (
                    <button onClick={() => onRemoveKit(k.id)}
                      style={{ position: "absolute", top: 10, right: 10, width: 30, height: 30, background: C.paperDeep, border: `1px solid ${C.rust}`, color: C.rust, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                      title="Remove from this list" aria-label="Remove">
                      <X size={13} />
                    </button>
                  )}
                  <Coord>KIT</Coord>
                  <div style={{ marginTop: 4, fontFamily: F.display, fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05, paddingRight: 36 }}>
                    {k.name}
                  </div>
                  <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                    {itemNames.length} {itemNames.length === 1 ? "item" : "items"}  /  {kitWeightStr}
                  </div>
                  {k.category && (
                    <div style={{ marginTop: 8 }}>
                      <span style={{
                        padding: "3px 8px",
                        fontFamily: F.mono,
                        fontSize: 9,
                        letterSpacing: "0.18em",
                        textTransform: "uppercase",
                        border: `1.5px solid ${C.forest}`,
                        color: C.forest,
                        fontWeight: 700,
                      }}>
                        {tOrLiteral(lang, "cat", k.category)}
                      </span>
                    </div>
                  )}
                  {itemNames.length > 0 && (
                    <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 5 }}>
                      {itemNames.map((it) => (
                        <span key={it.id} style={{ padding: "3px 8px", fontFamily: F.mono, fontSize: 10, letterSpacing: "0.05em", border: `1px solid ${C.ink}`, background: C.paperDeep }}>
                          {it.name}
                        </span>
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
              <div key={it.id} style={{ background: C.paper, border: `1px solid ${C.line}`, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
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
                    <button onClick={() => onRemoveItem(it.id)}
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
          <SharePreview
            share={reviewing}
            existingItems={items}
            existingKits={kits}
            onCancel={() => setReviewingId(null)}
            onAccept={(opts) => importShare(reviewing, opts)}
          />
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

// Inbox card for a pending share
function InboxCard({ share, fmtDate, onReview, onDecline, declining, confirmDecline, cancelDecline }) {
  const { t } = useI18n();
  const { isMobile } = useViewport();
  const entityName = share.payload?.kit?.name || share.payload?.category?.name || share.payload?.trip?.name || share.kind;
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
    <SettingGroup title={t("lib.mySubsTitle")} num="03">
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
  const [items, setItems] = useState(SEED_ITEMS);
  const [categories, setCategories] = useState(SEED_CATEGORIES);
  const [travelTypes, setTravelTypes] = useState(SEED_TRAVEL_TYPES);
  const [cart, setCart] = useState(SEED_CART);
  const [trips, setTrips] = useState(SEED_TRIPS);
  const [kits, setKits] = useState(SEED_KITS);
  const [packlists, setPacklists] = useState(SEED_PACKLISTS);
  const [inbox, setInbox] = useState(SEED_INBOX);
  const [locationEnabled, setLocationEnabled] = useState(false);
  const [inventoryFilter, setInventoryFilter] = useState(null);
  const [language, setLanguage] = useState("en");
  const [units, setUnits] = useState("metric"); // "metric" | "imperial"
  const [loaded, setLoaded] = useState(false);
  const [storageStatus, setStorageStatus] = useState("init");

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
            if (data.user) setUser({ name: "", email: "", username: "", region: "", ...data.user });
            if (Array.isArray(data.takenUsernames)) setTakenUsernames(data.takenUsernames);
            if (Array.isArray(data.items)) setItems(data.items);
            if (Array.isArray(data.categories)) setCategories(data.categories);
            if (Array.isArray(data.travelTypes)) setTravelTypes(data.travelTypes);
            if (Array.isArray(data.cart)) setCart(data.cart);
            if (Array.isArray(data.kits)) setKits(data.kits);

            // === Migration (one-time) ===
            // Trips and packlists used to be separate; they're now unified as
            // packlists with optional trip metadata. We:
            //   1) Start from any existing packlists (they're already the right shape).
            //   2) Match each old trip to a packlist by name; if matched, copy trip
            //      metadata onto it. If unmatched, create a new packlist for the trip.
            // Already-migrated data has data._merged === true so we skip on subsequent loads.
            const oldPacklists = Array.isArray(data.packlists) ? data.packlists : [];
            const oldTrips = Array.isArray(data.trips) ? data.trips : [];
            if (data._merged) {
              setPacklists(oldPacklists);
              setTrips([]);
            } else {
              const usedTripIds = new Set();
              const merged = oldPacklists.map((p) => {
                const matchedTrip = oldTrips.find((tr) =>
                  !usedTripIds.has(tr.id) && tr.name && p.name &&
                  tr.name.toLowerCase() === p.name.toLowerCase()
                );
                if (matchedTrip) {
                  usedTripIds.add(matchedTrip.id);
                  return {
                    ...p,
                    dest: matchedTrip.dest || p.dest || "",
                    date: matchedTrip.date || p.date || "",
                    type: matchedTrip.type || p.type || "",
                    categoryIds: p.categoryIds || [],
                  };
                }
                return { ...p, categoryIds: p.categoryIds || [] };
              });
              // Trips with no matching packlist become new packlists
              oldTrips.forEach((tr) => {
                if (!usedTripIds.has(tr.id)) {
                  merged.unshift({
                    id: uid("pl"),
                    name: tr.name,
                    notes: "",
                    dest: tr.dest || "",
                    date: tr.date || "",
                    type: tr.type || "",
                    kitIds: [],
                    itemIds: [],
                    categoryIds: [],
                  });
                }
              });
              setPacklists(merged);
              setTrips([]);  // trips array is now empty — packlists is the source of truth
            }
            if (Array.isArray(data.inbox)) setInbox(data.inbox);
            if (typeof data.locationEnabled === "boolean") setLocationEnabled(data.locationEnabled);
            if (data.language === "en" || data.language === "es") setLanguage(data.language);
            if (data.units === "metric" || data.units === "imperial") setUnits(data.units);
          } catch (e) {
            // corrupted JSON — fall back to seeds
          }
        }
        if (!cancelled) { setStorageStatus("ready"); setLoaded(true); }
      } catch (e) {
        // key doesn't exist (first run) — keep seeds, will be saved on next change
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

  // Persist whenever any tracked piece of state changes (after initial load)
  useEffect(() => {
    if (!loaded) return;
    if (typeof window === "undefined" || !window.localStorage) return;
    setStorageStatus("saving");
    const payload = JSON.stringify({ user, takenUsernames, items, categories, travelTypes, cart, trips, kits, packlists, inbox, locationEnabled, language, units, _merged: true });
    try {
      window.localStorage.setItem(STORAGE_KEY, payload);
      setStorageStatus("ready");
    } catch (e) {
      setStorageStatus("error");
    }
  }, [loaded, user, takenUsernames, items, categories, travelTypes, cart, trips, kits, packlists, inbox, locationEnabled, language, units]);

  const resetData = async () => {
    // Sign out from Supabase if we're authenticated
    try { await supabaseService.signOut(); } catch (e) { /* ignore */ }
    setUser({ name: "", email: "", username: "", region: "" });
    setTakenUsernames([]);
    setItems(SEED_ITEMS);
    setCategories(SEED_CATEGORIES);
    setTravelTypes(SEED_TRAVEL_TYPES);
    setCart(SEED_CART);
    setTrips(SEED_TRIPS);
    setKits(SEED_KITS);
    setPacklists(SEED_PACKLISTS);
    setInbox(SEED_INBOX);
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
    screen === "dashboard" ? <Dashboard go={go} user={user} trips={trips} cart={cart} items={items} packlists={packlists} kits={kits} locationEnabled={locationEnabled} /> :
    screen === "inventory" ? <Inventory go={go} items={items} setItems={setItems} categories={categories} setCategories={setCategories} travelTypes={travelTypes} setTravelTypes={setTravelTypes} kits={kits} setKits={setKits} packlists={packlists} setPacklists={setPacklists} cart={cart} setCart={setCart} shareService={shareService} currentUser={user} filter={inventoryFilter} clearFilter={clearInventoryFilter} /> :
    screen === "trips" ? <Trips go={go} trips={trips} setTrips={setTrips} travelTypes={travelTypes} setTravelTypes={setTravelTypes} shareService={shareService} currentUser={user} items={items} setItems={setItems} kits={kits} setKits={setKits} categories={categories} setCategories={setCategories} packlists={packlists} setPacklists={setPacklists} /> :
    screen === "packlists" ? <Packlists go={go} packlists={packlists} setPacklists={setPacklists} kits={kits} setKits={setKits} items={items} setItems={setItems} categories={categories} setCategories={setCategories} travelTypes={travelTypes} setTravelTypes={setTravelTypes} /> :
    screen === "cart" ? <Cart go={go} cart={cart} setCart={setCart} /> :
    screen === "inbox" ? <Inbox go={go} inbox={inbox} setInbox={setInbox} items={items} setItems={setItems} kits={kits} setKits={setKits} categories={categories} setCategories={setCategories} trips={trips} setTrips={setTrips} packlists={packlists} setPacklists={setPacklists} shareService={shareService} /> :
    screen === "library" ? <Library go={go} currentUser={user} items={items} setItems={setItems} kits={kits} setKits={setKits} categories={categories} setCategories={setCategories} trips={trips} setTrips={setTrips} packlists={packlists} setPacklists={setPacklists} /> :
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
        {inner}
      </div>
    </I18nContext.Provider>
  );
}
