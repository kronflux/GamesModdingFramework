using UnityEngine;

namespace Fixture.Game
{
    public class Player : MonoBehaviour
    {
        public int Health;
        private float speed = 1.5f;

        private void Awake()
        {
            Debug.Log("Player awake");
        }

        public void TakeDamage(int amount)
        {
            Health -= amount;
            Debug.Log("Ouch");
        }

        public static Player Create()
        {
            return new Player();
        }
    }

    public struct Stats
    {
        public int Level;
    }
}
