import { createContext, useContext } from "react";
import type {
  Profile, ProviderCapabilities, UserProfile, UserProfileState, CreateSessionOpts,
} from "../../../sdk/index";
import type { SessionSetupState } from "../components/SessionSetup";

type ProfileContextValue = {
  profiles: Profile[];
  visibleProfiles: Profile[];
  availableProviders: string[];
  providerCapabilities: Record<string, ProviderCapabilities>;
  userProfiles: UserProfile[];
  activeUserProfile: string | null;
  activeUP: UserProfile | null;
  activeCwd: string | undefined;
  /** Project root — always the user profile's first project, not a profile subfolder */
  projectRoot: string | undefined;
  selectedProfile: string;
  selectProfile: (name: string) => void;
  setSelectedProfile: (name: string) => void;
  setupState: SessionSetupState;
  setSetupState: React.Dispatch<React.SetStateAction<SessionSetupState>>;
  uiState: UserProfileState;
  saveUiState: (patch: Partial<UserProfileState>) => void;
  switchUserProfile: (name: string | null) => void;
  refreshProfiles: () => Promise<void>;
  refreshUserProfiles: () => Promise<void>;
  buildSessionOpts: (prompt: string, profile?: string, seed?: SessionSetupState) => CreateSessionOpts;
};

export const ProfileContext = createContext<ProfileContextValue>(null!);
export const useProfiles = () => useContext(ProfileContext);
