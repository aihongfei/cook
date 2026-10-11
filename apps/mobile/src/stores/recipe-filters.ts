import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

interface RecipeFilters {
  category: string
  cuisine: string
  setCategory: (category: string) => void
  setCuisine: (cuisine: string) => void
  reset: () => void
}

// Only non-sensitive preferences persist; recipes remain online data.
export const useRecipeFilters = create<RecipeFilters>()(
  persist(
    (set) => ({
      category: '',
      cuisine: '',
      setCategory: (category) => set({ category }),
      setCuisine: (cuisine) => set({ cuisine }),
      reset: () => set({ category: '', cuisine: '' }),
    }),
    {
      name: 'yushan-recipe-filters',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ category, cuisine }) => ({ category, cuisine }),
    },
  ),
)
