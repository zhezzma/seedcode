import {
    Squares2X2Icon,
    HomeIcon,
    Cog6ToothIcon,
    CubeIcon,
    ChatBubbleLeftRightIcon,
    DocumentTextIcon,
    ClockIcon,
    PuzzlePieceIcon,
    ServerStackIcon
} from '@heroicons/vue/24/outline'

import {
    HomeIcon as HomeIconSolid,
    Squares2X2Icon as Squares2X2IconSolid,
    Cog6ToothIcon as Cog6ToothIconSolid,
    CubeIcon as CubeIconSolid,
    ChatBubbleLeftRightIcon as ChatBubbleLeftRightIconSolid,
    DocumentTextIcon as DocumentTextIconSolid,
    ClockIcon as ClockIconSolid,
    PuzzlePieceIcon as PuzzlePieceIconSolid,
    ServerStackIcon as ServerStackIconSolid
} from '@heroicons/vue/24/solid'

export interface NavItem {
    label: string
    icon: any
    route: string
    query?: Record<string, string>
    activeIcon?: any
    showInSidebar?: boolean
}

export const ALL_NAV_ITEMS: NavItem[] = [
    {
        label: 'sidebar.home',
        icon: HomeIcon,
        activeIcon: HomeIconSolid,
        route: 'home',
        showInSidebar: false
    },
    {
        label: 'agent.agents',
        icon: Squares2X2Icon,
        activeIcon: Squares2X2IconSolid,
        route: 'agents',
        showInSidebar: true
    },
    {
        label: 'sidebar.models',
        icon: CubeIcon,
        activeIcon: CubeIconSolid,
        route: 'models',
        showInSidebar: true
    },
    {
        label: 'extensions.title',
        icon: PuzzlePieceIcon,
        activeIcon: PuzzlePieceIconSolid,
        route: 'extensions',
        showInSidebar: true
    },
    {
        label: 'prompt.title',
        icon: DocumentTextIcon,
        activeIcon: DocumentTextIconSolid,
        route: 'prompts',
        showInSidebar: true
    },
    {
        label: 'mcp.title',
        icon: ServerStackIcon,
        activeIcon: ServerStackIconSolid,
        route: 'mcp',
        showInSidebar: true
    },
    {
        label: 'sidebar.cron',
        icon: ClockIcon,
        activeIcon: ClockIconSolid,
        route: 'cron',
        showInSidebar: true
    },
    {
        label: 'settings.title',
        icon: Cog6ToothIcon,
        activeIcon: Cog6ToothIconSolid,
        route: 'settings',
        showInSidebar: false // Sidebar has a separate settings button usually
    }
]

export const SIDEBAR_ITEMS = ALL_NAV_ITEMS.filter(item => item.showInSidebar)
