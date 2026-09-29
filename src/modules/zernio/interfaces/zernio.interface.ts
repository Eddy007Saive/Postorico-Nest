export interface ZernioMediaItem {
  url: string;
  type: 'image' | 'video' | 'document';
  thumbnail?: string;
}

export interface ZernioPlatformEntry {
  platform: string;
  accountId: string;
  platformSpecificData?: Record<string, unknown>;
}

export interface ZernioCreatePostPayload {
  content: string;
  platforms: ZernioPlatformEntry[];
  mediaItems?: ZernioMediaItem[];
  timezone?: string;
  publishNow?: boolean;
  scheduledFor?: string;
}

export interface ZernioPost {
  id?: string;
  status?: string;
  platforms?: Array<{
    platform?: string;
    publishedUrl?: string;
    platformPostUrl?: string;
    url?: string;
    error?: string;
  }>;
}

export interface ZernioCreatePostResponse {
  message?: string;
  post?: ZernioPost;
}

export interface ZernioGetPostResponse {
  message?: string;
  post?: ZernioPost;
}

export interface ZernioAccount {
  field_id?: string;
  _id?: string;
  id?: string;
  platform?: string;
  username?: string;
  displayName?: string;
  profilePicture?: string;
  profileUrl?: string;
  isActive?: boolean;
  profileId?: string | { field_id?: string };
}

export interface ZernioAccountsListResponse {
  accounts?: ZernioAccount[];
  data?: ZernioAccount[];
}

export interface ZernioProfile {
  _id?: string;
  field_id?: string;
  name?: string;
}

export interface ZernioProfilesListResponse {
  profiles?: ZernioProfile[];
  data?: ZernioProfile[];
}

export interface ZernioProfileCreateResponse {
  message?: string;
  profile?: ZernioProfile;
}

export interface ZernioConnectUrlResponse {
  authUrl?: string;
  url?: string;
  connectUrl?: string;
}
